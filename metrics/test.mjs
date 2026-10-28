// node --test metrics/test.mjs
//
// The schema, scrubbing and aggregation tests need nothing. The service tests need a Postgres:
// METRICS_TEST_DATABASE_URL (the local localinfra_metrics database on Docker Desktop is fine,
// e.g. postgresql://localinfra_metrics:<pw>@localhost:5432/localinfra_metrics). They run in a
// throwaway schema that is dropped at the end; without the variable they are skipped.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { parseBatch, scrub, cleanRoute, quantile, bucketOf } from "./schema.mjs";
import { createAggregator, OTHER } from "./aggregate.mjs";
import { openStore } from "./store.mjs";
import { configFromEnv, createService } from "./server.mjs";

describe("schema", () => {
  test("accepts a good batch and cleans it", () => {
    const r = parseBatch({
      device: "mobile",
      events: [
        { t: "view", route: "/xadrez/[code]" },
        { t: "vital", route: "/", name: "LCP", value: 1234.5 },
        { t: "error", route: "/(app)/recipes/[id]", name: "TypeError", message: "x of user@mail.com at https://a.b/c?d=1 id 123456", source: "page-1a2b.js:10:4" },
      ],
    });
    assert.equal(r.ok, true);
    assert.equal(r.device, "mobile");
    assert.equal(r.events[2].route, "/recipes/[id]");
    assert.equal(r.events[2].kind, "client");
    assert.equal(r.events[2].message, "x of <email> at <url> id <n>");
  });

  test("rejects anything outside the schema, whole", () => {
    const bad = [
      null,
      [],
      { events: [] },
      { device: "tablet", events: [{ t: "view", route: "/" }] },
      { events: [{ t: "view", route: "/a?b=1" }] },
      { events: [{ t: "view", route: "relative" }] },
      { events: [{ t: "view", route: "/" + "a".repeat(130) }] },
      { events: [{ t: "vital", route: "/", name: "XYZ", value: 1 }] },
      { events: [{ t: "vital", route: "/", name: "LCP", value: -1 }] },
      { events: [{ t: "vital", route: "/", name: "LCP", value: "1" }] },
      { events: [{ t: "vital", route: "/", name: "CLS", value: 1000 }] },
      { events: [{ t: "error", route: "/", message: 3 }] },
      { events: [{ t: "error", route: "/", kind: "admin", message: "x" }] },
      { events: [{ t: "click", route: "/" }] },
      { events: Array.from({ length: 51 }, () => ({ t: "view", route: "/" })) },
      { events: [{ t: "view", route: "/" }, { t: "view", route: "/<script>" }] },
    ];
    for (const b of bad) assert.equal(parseBatch(b).ok, false, JSON.stringify(b)?.slice(0, 80));
  });

  test("routes, names and sources", () => {
    assert.equal(cleanRoute("/"), "/");
    assert.equal(cleanRoute("/(auth)/login"), "/login");
    assert.equal(cleanRoute("/docs/[...slug]"), "/docs/[...slug]");
    assert.equal(cleanRoute("/shop/[[...slug]]"), "/shop/[[...slug]]");
    assert.equal(cleanRoute("/a b"), null);
    const r = parseBatch({ events: [{ t: "error", route: "/", name: "not a name!", message: "m", source: "https://x.y/z.js:1" }] });
    assert.equal(r.events[0].name, "Error");
    assert.equal(r.events[0].source, "");
  });

  test("scrub removes personal data and caps the length", () => {
    assert.equal(scrub("token abcdef0123456789abcdef in a@b.co"), "token <id> in <email>");
    assert.equal(scrub("x".repeat(500)).length, 160);
    assert.equal(scrub("line\nbreak\u0000"), "line break");
  });

  test("histogram buckets and quantiles", () => {
    assert.equal(bucketOf("LCP", 50), 0);
    assert.equal(bucketOf("LCP", 100), 0);
    assert.equal(bucketOf("LCP", 101), 1);
    assert.equal(bucketOf("LCP", 99999), 11);
    assert.equal(bucketOf("CLS", 0.3), 8);
    const hist = new Array(12).fill(0);
    hist[7] = 4; // 1800..2500
    assert.equal(quantile("LCP", hist, 0.5), 2150);
    assert.equal(quantile("LCP", new Array(12).fill(0), 0.5), null);
    const tail = new Array(12).fill(0);
    tail[11] = 1;
    assert.equal(quantile("LCP", tail, 0.75), 10000);
  });
});

describe("aggregator", () => {
  test("adds hourly and daily rows, with caps per app and day", () => {
    const agg = createAggregator({ maxRoutes: 2, maxErrors: 1 });
    const at = Date.UTC(2026, 9, 27, 15, 30);
    agg.add("a", "mobile", [{ t: "view", route: "/" }, { t: "view", route: "/x" }, { t: "view", route: "/y" }], at);
    agg.add("a", "mobile", [{ t: "vital", route: "/", name: "LCP", value: 900 }, { t: "vital", route: "/", name: "LCP", value: 3000 }], at);
    agg.add("b", "desktop", [{ t: "view", route: "/y" }], at);
    const err = (message) => ({ t: "error", route: "/", kind: "client", name: "Error", message, source: "" });
    agg.add("a", "desktop", [err("one"), err("one"), err("two")], at);
    assert.equal(agg.pending, 9);
    const rows = agg.drain();
    assert.equal(agg.pending, 0);
    const hourViews = rows.views.filter((r) => r.grain === "hour" && r.app === "a").map((r) => r.route).sort();
    assert.deepEqual(hourViews, [OTHER, "/", "/x"]);
    assert.ok(rows.views.some((r) => r.app === "b" && r.route === "/y"), "caps are per app");
    const lcp = rows.vitals.find((r) => r.grain === "day");
    assert.equal(lcp.n, 2);
    assert.equal(lcp.sum, 3900);
    assert.equal(lcp.hist[5] + lcp.hist[8], 2);
    const errs = rows.errors.filter((r) => r.grain === "hour");
    assert.equal(errs.length, 2);
    assert.equal(errs.find((e) => e.name === "Error").n, 2);
    assert.equal(errs.find((e) => e.name === OTHER).n, 1);
  });

  test("restore puts a failed flush back", () => {
    const agg = createAggregator();
    agg.add("a", "mobile", [{ t: "vital", route: "/", name: "INP", value: 50 }]);
    const rows = agg.drain();
    agg.add("a", "mobile", [{ t: "vital", route: "/", name: "INP", value: 50 }]);
    agg.restore(rows);
    const again = agg.drain();
    assert.equal(again.events, 2);
    assert.equal(again.vitals.find((r) => r.grain === "hour").n, 2);
  });
});

const DB = process.env.METRICS_TEST_DATABASE_URL;
describe("summary scheduling (no Postgres)", () => {
  // store.summary() is slow here; a flush lands while it runs (the real race: the summary read the
  // daily rows before the flush and the hourly rows after, or missed the flush altogether)
  function fakeService() {
    const dir = mkdtempSync(join(tmpdir(), "metrics-sched-"));
    const summaries = [];
    let release;
    const store = {
      findApp: async () => "app_one",
      today: async () => ({ apps: new Map() }),
      flush: async () => {},
      summary: async () => {
        summaries.push(Date.now());
        if (summaries.length === 1) await new Promise((resolve) => (release = resolve));
        return { generated_at: new Date().toISOString(), apps: {} };
      },
    };
    const config = configFromEnv({ METRICS_SUMMARY_PATH: join(dir, "summary.json") });
    return { service: createService(config, store), summaries, release: () => release(), dir };
  }

  test("a flush during the summary is picked up by the next run, not 15 minutes later", async () => {
    const { service, summaries, release, dir } = fakeService();
    try {
      const first = service.writeSummary(true); // starts computing, blocked inside store.summary()
      await new Promise((resolve) => setImmediate(resolve));
      service.aggregator.add("app_one", "desktop", [{ t: "view", route: "/" }]);
      await service.flush(); // lands while the summary is being computed
      release();
      await first;
      await service.writeSummary(); // the regular tick, not forced
      assert.equal(summaries.length, 2, "the data flushed mid-summary must trigger another summary");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failed summary is retried on the next tick", async () => {
    const dir = mkdtempSync(join(tmpdir(), "metrics-sched-"));
    let calls = 0;
    const store = {
      summary: async () => {
        if (++calls === 1) throw new Error("db down");
        return { generated_at: new Date().toISOString(), apps: {} };
      },
    };
    const service = createService(configFromEnv({ METRICS_SUMMARY_PATH: join(dir, "summary.json") }), store);
    try {
      await service.writeSummary(true).catch(() => {});
      await service.writeSummary();
      assert.equal(calls, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("service (Postgres)", { skip: !DB && "METRICS_TEST_DATABASE_URL is not set" }, () => {
  const schema = "metrics_test_" + process.pid;
  let admin, dir, service, store, base, key, otherKey;
  const post = (body, headers = {}) =>
    fetch(base + "/v1/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  before(async () => {
    admin = postgres(DB, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    dir = mkdtempSync(join(tmpdir(), "metrics-test-"));
    store = openStore(DB, { schema });
    await store.migrate();
    const config = configFromEnv({ METRICS_SUMMARY_PATH: join(dir, "summary.json"), METRICS_RATE_PER_MIN: "60", METRICS_FLUSH_MS: "3600000", METRICS_SUMMARY_MS: "3600000" });
    service = createService(config, store);
    await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${service.server.address().port}`;
    key = await store.rotate("app_one");
    otherKey = await store.rotate("app_two");
  });

  after(async () => {
    await new Promise((r) => service.server.close(r));
    await store.close();
    await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    rmSync(dir, { recursive: true, force: true });
  });

  test("health needs no key", async () => {
    const res = await fetch(base + "/health");
    assert.equal(res.status, 200);
  });

  test("unknown or missing keys get 401", async () => {
    assert.equal((await post({ events: [{ t: "view", route: "/" }] }, { Authorization: "" })).status, 401);
    assert.equal((await post({ events: [{ t: "view", route: "/" }] }, { Authorization: "Bearer mx_" + "0".repeat(48) })).status, 401);
    assert.equal((await post({ events: [{ t: "view", route: "/" }] }, { Authorization: "Bearer llm_abc" })).status, 401);
  });

  test("bad bodies: 400, too big: 413", async () => {
    assert.equal((await post("not json")).status, 400);
    assert.equal((await post({ events: [{ t: "view", route: "/a?b" }] })).status, 400);
    assert.equal((await post("x".repeat(17 * 1024))).status, 413);
  });

  test("a rotated key replaces the old one", async () => {
    const old = otherKey;
    otherKey = await store.rotate("app_two");
    assert.equal((await post({ events: [{ t: "view", route: "/" }] }, { Authorization: "Bearer " + old })).status, 401);
    assert.equal((await post({ events: [{ t: "view", route: "/" }] }, { Authorization: "Bearer " + otherKey })).status, 202);
  });

  test("events are aggregated, flushed and summed across flushes", async () => {
    const vitals = [700, 1500, 2000, 2300].map((value) => ({ t: "vital", route: "/xadrez/[code]", name: "LCP", value }));
    let res = await post({ device: "mobile", events: [{ t: "view", route: "/xadrez/[code]" }, ...vitals.slice(0, 2)] });
    assert.equal(res.status, 202);
    await service.flush();
    res = await post({ device: "mobile", events: [{ t: "view", route: "/xadrez/[code]" }, ...vitals.slice(2)] });
    await post({ device: "desktop", events: [{ t: "error", route: "/", name: "TypeError", message: "boom 12345", source: "a.js:1" }] });
    await service.flush();

    const [row] = await store.sql`SELECT n, sum, hist FROM vitals_daily WHERE app = 'app_one' AND metric = 'LCP'`;
    assert.equal(row.n, 4);
    assert.equal(row.sum, 6500);
    assert.equal(row.hist.reduce((a, b) => a + b, 0), 4);
    const [views] = await store.sql`SELECT n FROM views_hourly WHERE app = 'app_one' AND route = '/xadrez/[code]'`;
    assert.equal(views.n, 2);
    const [err] = await store.sql`SELECT message, n FROM errors_daily WHERE app = 'app_one'`;
    assert.equal(err.message, "boom <n>");
    // the other app's rows are its own
    const two = await store.sql`SELECT count(*)::int AS c FROM views_daily WHERE app = 'app_two'`;
    assert.equal(two[0].c, 1);
  });

  test("the summary file has p75s, top routes and errors per app", async () => {
    await service.writeSummary(true);
    const s = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
    const day = s.apps.app_one.ranges["24h"];
    assert.equal(day.views, 2);
    assert.equal(day.devices.mobile, 2);
    assert.equal(day.vitals.LCP.n, 4);
    assert.ok(day.vitals.LCP.p75 > 1800 && day.vitals.LCP.p75 <= 2500, String(day.vitals.LCP.p75));
    assert.equal(day.vitals.LCP.mobile.n, 4);
    assert.equal(day.routes[0].route, "/xadrez/[code]");
    assert.equal(day.errors[0].count, 1);
    assert.equal(s.apps.app_one.ranges["30d"].views, 2);
    assert.equal(s.apps.app_one.daily.length, 1);
    assert.ok(s.apps.app_two);
    assert.deepEqual(Object.keys(s.retention), ["hourlyDays", "dailyDays", "errorDays"]);
  });

  test("rate limit per app: 429 past the limit", async () => {
    const many = { events: Array.from({ length: 50 }, () => ({ t: "view", route: "/" })) };
    let last;
    for (let i = 0; i < 3; i++) last = (await post(many)).status;
    assert.equal(last, 429);
    service.aggregator.drain();
  });

  test("retention removes old rows only", async () => {
    const old = new Date(Date.now() - 400 * 86400000).toISOString();
    await store.sql`INSERT INTO views_daily (app, bucket, route, device, n) VALUES ('app_one', ${old}, '/', 'mobile', 1)`;
    await store.sql`INSERT INTO views_hourly (app, bucket, route, device, n) VALUES ('app_one', ${old}, '/', 'mobile', 1)`;
    const removed = await store.prune({ hourlyDays: 7, dailyDays: 180, errorDays: 90 });
    assert.equal(removed, 2);
    const [{ c }] = await store.sql`SELECT count(*)::int AS c FROM views_daily WHERE app = 'app_one'`;
    assert.equal(c, 1);
  });

  test("today's routes seed the caps after a restart", async () => {
    const t = await store.today();
    assert.ok(t.apps.get("app_one").routes.includes("/xadrez/[code]"));
    assert.equal(t.apps.get("app_one").fingerprints.length, 1);
  });
});
