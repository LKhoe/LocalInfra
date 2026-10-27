// LocalInfra metrics: the apps send light, anonymous usage metrics here (Web Vitals, route views,
// errors), and the Container Health status page shows them.
//
//   POST /v1/events   a batch from an app (Authorization: Bearer mx_..., see schema.mjs)
//   GET  /health      for the healthcheck (no auth)
//
// Only reachable on the internal network localinfra_metrics: no published port, no tunnel route.
// Each app's own /api/metrics route checks, rate-limits and forwards what browsers send; this
// service checks everything again, aggregates in memory and adds it to Postgres every minute.
// It also writes /run/metrics/summary.json (a small volume), which Container Health reads through Docker.
import http from "node:http";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseBatch } from "./schema.mjs";
import { createAggregator, dayStart } from "./aggregate.mjs";
import { openStore, hashKey } from "./store.mjs";

const MAX_BODY_BYTES = 16 * 1024;
const number = (value, fallback) => (value === undefined || value === "" ? fallback : Number(value));

export function configFromEnv(env = process.env) {
  return {
    port: number(env.PORT, 4100),
    databaseUrl: env.METRICS_DATABASE_URL || "",
    summaryPath: env.METRICS_SUMMARY_PATH || "/run/metrics/summary.json",
    flushMs: number(env.METRICS_FLUSH_MS, 60000),
    summaryMs: number(env.METRICS_SUMMARY_MS, 60000),
    ratePerMinute: number(env.METRICS_RATE_PER_MIN, 2000),
    maxRoutes: number(env.METRICS_MAX_ROUTES, 60),
    maxErrors: number(env.METRICS_MAX_ERRORS, 100),
    keep: {
      hourlyDays: number(env.METRICS_KEEP_HOURLY_DAYS, 7),
      dailyDays: number(env.METRICS_KEEP_DAILY_DAYS, 180),
      errorDays: number(env.METRICS_KEEP_ERROR_DAYS, 90),
    },
  };
}

export function createService(config, store = openStore(config.databaseUrl)) {
  const agg = createAggregator({ maxRoutes: config.maxRoutes, maxErrors: config.maxErrors });
  let seededDay = 0;
  let dirty = true; // the summary needs writing
  let lastSummary = 0;

  // ------------------------------------------------------------------ keys
  // A known key is cached 5 minutes; an unknown one 30 seconds, so a bad key can't hammer the DB
  const keyCache = new Map(); // hash → { app | null, until }
  async function appFor(key) {
    if (!/^mx_[0-9a-f]{48}$/.test(key)) return null;
    const h = hashKey(key);
    const hit = keyCache.get(h);
    if (hit && hit.until > Date.now()) return hit.app;
    const app = await store.findApp(key);
    if (keyCache.size > 1000) keyCache.clear();
    keyCache.set(h, { app, until: Date.now() + (app ? 300000 : 30000) });
    return app;
  }

  // ------------------------------------------------------------------ rate limit (per app, per minute)
  const windows = new Map(); // app → { minute, count }
  function allow(app, n) {
    const minute = Math.floor(Date.now() / 60000);
    let w = windows.get(app);
    if (!w || w.minute !== minute) windows.set(app, (w = { minute, count: 0 }));
    if (w.count + n > config.ratePerMinute) return false;
    w.count += n;
    return true;
  }

  // ------------------------------------------------------------------ flush, summary, retention
  async function seedToday() {
    const day = dayStart(Date.now());
    if (day === seededDay) return;
    const { apps } = await store.today();
    for (const [app, t] of apps) agg.seed(app, day, t.routes, t.fingerprints);
    seededDay = day;
  }

  let flushing = null;
  async function flush() {
    if (flushing) return flushing;
    if (!agg.pending) return;
    const rows = agg.drain();
    flushing = store
      .flush(rows)
      .then(() => {
        dirty = true;
      })
      .catch((err) => {
        agg.restore(rows);
        console.error(`[metrics] flush failed, keeping ${rows.events} events for the next try: ${err.message}`);
      })
      .finally(() => {
        flushing = null;
      });
    return flushing;
  }

  async function writeSummary(force = false) {
    // Every minute after new data, and every 15 minutes anyway (the 24h window slides)
    if (!force && !dirty && Date.now() - lastSummary < 15 * 60000) return;
    const summary = await store.summary();
    summary.retention = config.keep;
    mkdirSync(dirname(config.summaryPath), { recursive: true });
    const tmp = config.summaryPath + ".tmp";
    writeFileSync(tmp, JSON.stringify(summary));
    renameSync(tmp, config.summaryPath);
    dirty = false;
    lastSummary = Date.now();
  }

  async function prune() {
    const removed = await store.prune(config.keep);
    if (removed) console.log(`[metrics] retention: removed ${removed} rows`);
  }

  // ------------------------------------------------------------------ HTTP
  async function readBody(req) {
    if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) throw Object.assign(new Error("Request body too large"), { status: 413 });
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw Object.assign(new Error("Request body too large"), { status: 413 });
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw Object.assign(new Error("Request body is not JSON"), { status: 400 });
    }
  }

  async function route(req) {
    const path = new URL(req.url, "http://x").pathname.replace(/\/$/, "");
    if (req.method === "GET" && (path === "/health" || path === "/healthz")) {
      await store.ping();
      return [200, { status: "ok", pending: agg.pending }];
    }
    if (path !== "/v1/events") return [404, { error: "not found" }];
    if (req.method !== "POST") return [405, { error: "POST only" }];

    const app = await appFor((req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
    if (!app) return [401, { error: "Missing or unknown metrics key (Authorization: Bearer mx_...). Provision one with scripts/new-project.sh <app> --metrics" }];
    const batch = parseBatch(await readBody(req));
    if (!batch.ok) return [400, { error: batch.error }];
    if (!allow(app, batch.events.length)) return [429, { error: `more than ${config.ratePerMinute} events per minute for ${app}` }];
    await seedToday().catch(() => {}); // without the seed the caps still work, just from zero
    agg.add(app, batch.device, batch.events);
    return [202, { accepted: batch.events.length }];
  }

  const server = http.createServer(async (req, res) => {
    let status, body;
    try {
      [status, body] = await route(req);
    } catch (err) {
      status = err.status || 500;
      body = { error: status === 500 ? "internal error" : err.message };
      if (status === 500) console.error("[metrics]", err);
    }
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;

  const timers = [];
  const safe = (what, fn) => () => fn().catch((err) => console.error(`[metrics] ${what} failed: ${err.message}`));
  server.on("listening", () => {
    safe("retention", prune)();
    safe("summary", () => writeSummary(true))();
    timers.push(setInterval(safe("flush", flush), config.flushMs).unref());
    timers.push(setInterval(safe("summary", () => writeSummary()), config.summaryMs).unref());
    timers.push(setInterval(safe("retention", prune), 6 * 3600 * 1000).unref());
  });
  server.on("close", () => timers.forEach(clearInterval));

  return { server, store, flush, writeSummary, prune, aggregator: agg };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = configFromEnv();
  if (!config.databaseUrl) {
    console.error("[metrics] METRICS_DATABASE_URL is not set: run scripts/new-project.sh localinfra_metrics --no-redis and put its DATABASE_URL in LocalInfra's .env");
    process.exit(1);
  }
  const service = createService(config);
  await service.store.migrate();
  service.server.listen(config.port, () => {
    console.log(`[metrics] listening on :${config.port}; retention ${config.keep.hourlyDays}d hourly, ${config.keep.dailyDays}d daily, ${config.keep.errorDays}d errors`);
  });
  // Keep what's in memory: one last flush before stopping
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
      service.server.close();
      service.flush().finally(() => service.store.close().finally(() => process.exit(0)));
    });
  }
}
