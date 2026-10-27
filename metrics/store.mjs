// Postgres side of localinfra-metrics: its own role + database (localinfra_metrics), made by
// scripts/new-project.sh like any app. Only aggregates are stored:
//
//   app_keys                         app name + sha256 of its key (the key is shown once)
//   vitals_hourly / vitals_daily     (app, bucket, route, metric, device) → n, sum, hist[12]
//   views_hourly  / views_daily      (app, bucket, route, device) → n
//   errors_hourly / errors_daily     (app, bucket, kind, fingerprint, route) → name, message, source, n, last_seen
//
// Rows are added to (upsert), so a flush never reads first. prune() applies the retention.
import { createHash, randomBytes } from "node:crypto";
import postgres from "postgres";
import { quantile, METRICS } from "./schema.mjs";
import { dayStart } from "./aggregate.mjs";

const DAY = 86400 * 1000;
export const hashKey = (key) => createHash("sha256").update(key).digest("hex");
export const newKey = () => "mx_" + randomBytes(24).toString("hex");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS app_keys (
  app text PRIMARY KEY,
  key_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
${["hourly", "daily"].map((g) => `
CREATE TABLE IF NOT EXISTS vitals_${g} (
  app text NOT NULL, bucket timestamptz NOT NULL, route text NOT NULL, metric text NOT NULL, device text NOT NULL,
  n integer NOT NULL, sum double precision NOT NULL, hist integer[] NOT NULL,
  PRIMARY KEY (app, bucket, route, metric, device)
);
CREATE TABLE IF NOT EXISTS views_${g} (
  app text NOT NULL, bucket timestamptz NOT NULL, route text NOT NULL, device text NOT NULL, n integer NOT NULL,
  PRIMARY KEY (app, bucket, route, device)
);
CREATE TABLE IF NOT EXISTS errors_${g} (
  app text NOT NULL, bucket timestamptz NOT NULL, kind text NOT NULL, fingerprint text NOT NULL, route text NOT NULL,
  name text NOT NULL, message text NOT NULL, source text NOT NULL, n integer NOT NULL, last_seen timestamptz NOT NULL,
  PRIMARY KEY (app, bucket, kind, fingerprint, route)
);
CREATE INDEX IF NOT EXISTS vitals_${g}_bucket ON vitals_${g} (bucket);
CREATE INDEX IF NOT EXISTS views_${g}_bucket ON views_${g} (bucket);
CREATE INDEX IF NOT EXISTS errors_${g}_bucket ON errors_${g} (bucket);`).join("\n")}
`;

const table = (kind, grain) => `${kind}_${grain === "hour" ? "hourly" : "daily"}`;
const iso = (ms) => new Date(ms).toISOString();

// schema: another search_path, for the tests
export function openStore(url, { max = 3, schema } = {}) {
  if (!url) throw new Error("METRICS_DATABASE_URL is not set");
  const sql = postgres(url, {
    max, idle_timeout: 60, connect_timeout: 10, onnotice: () => {},
    ...(schema ? { connection: { search_path: schema } } : {}),
  });

  const migrate = () => sql.unsafe(SCHEMA);

  // ------------------------------------------------------------------ keys
  const findApp = async (key) => {
    if (!/^mx_[0-9a-f]{48}$/.test(key || "")) return null;
    const [row] = await sql`SELECT app FROM app_keys WHERE key_hash = ${hashKey(key)}`;
    return row?.app ?? null;
  };
  const listApps = async () => (await sql`SELECT app, created_at FROM app_keys ORDER BY app`).map((r) => r.app);
  const hasApp = async (app) => (await sql`SELECT 1 FROM app_keys WHERE app = ${app}`).length > 0;
  // New key for the app, adding it if missing; the old key stops working at once
  async function rotate(app) {
    const key = newKey();
    await sql`INSERT INTO app_keys (app, key_hash) VALUES (${app}, ${hashKey(key)})
              ON CONFLICT (app) DO UPDATE SET key_hash = excluded.key_hash, created_at = now()`;
    return key;
  }
  // The key stops working; the app's metrics stay until retention removes them
  const removeApp = (app) => sql`DELETE FROM app_keys WHERE app = ${app}`;

  // ------------------------------------------------------------------ writes
  // jsonb_to_recordset turns a JSON array into rows (and JSON arrays into int[]): one parameter per table
  async function flush({ vitals, views, errors }) {
    await sql.begin(async (tx) => {
      for (const grain of ["hour", "day"]) {
        const v = vitals.filter((r) => r.grain === grain).map((r) => ({ ...r, bucket: iso(r.bucket) }));
        if (v.length) {
          await tx.unsafe(
            `INSERT INTO ${table("vitals", grain)} AS t (app, bucket, route, metric, device, n, sum, hist)
             SELECT app, bucket, route, metric, device, n, sum, hist FROM jsonb_to_recordset($1::jsonb)
               AS x(app text, bucket timestamptz, route text, metric text, device text, n int, sum float8, hist int[])
             ON CONFLICT (app, bucket, route, metric, device) DO UPDATE SET
               n = t.n + excluded.n, sum = t.sum + excluded.sum,
               hist = ARRAY(SELECT coalesce(a, 0) + coalesce(b, 0) FROM unnest(t.hist, excluded.hist) WITH ORDINALITY AS u(a, b, i) ORDER BY i)`,
            [v],
          );
        }
        const w = views.filter((r) => r.grain === grain).map((r) => ({ ...r, bucket: iso(r.bucket) }));
        if (w.length) {
          await tx.unsafe(
            `INSERT INTO ${table("views", grain)} AS t (app, bucket, route, device, n)
             SELECT app, bucket, route, device, n FROM jsonb_to_recordset($1::jsonb)
               AS x(app text, bucket timestamptz, route text, device text, n int)
             ON CONFLICT (app, bucket, route, device) DO UPDATE SET n = t.n + excluded.n`,
            [w],
          );
        }
        const e = errors.filter((r) => r.grain === grain).map((r) => ({ ...r, bucket: iso(r.bucket), last_seen: iso(r.last_seen) }));
        if (e.length) {
          await tx.unsafe(
            `INSERT INTO ${table("errors", grain)} AS t (app, bucket, kind, fingerprint, route, name, message, source, n, last_seen)
             SELECT app, bucket, kind, fingerprint, route, name, message, source, n, last_seen FROM jsonb_to_recordset($1::jsonb)
               AS x(app text, bucket timestamptz, kind text, fingerprint text, route text, name text, message text, source text, n int, last_seen timestamptz)
             ON CONFLICT (app, bucket, kind, fingerprint, route) DO UPDATE SET
               n = t.n + excluded.n, last_seen = greatest(t.last_seen, excluded.last_seen)`,
            [e],
          );
        }
      }
    });
  }

  // What today already holds, for the aggregator's caps
  async function today(now = Date.now()) {
    const day = iso(dayStart(now));
    const routes = await sql`SELECT DISTINCT app, route FROM views_daily WHERE bucket = ${day}
                             UNION SELECT DISTINCT app, route FROM vitals_daily WHERE bucket = ${day}`;
    const fps = await sql`SELECT DISTINCT app, fingerprint FROM errors_daily WHERE bucket = ${day}`;
    const byApp = new Map();
    const get = (app) => byApp.get(app) || byApp.set(app, { routes: [], fingerprints: [] }).get(app);
    for (const r of routes) get(r.app).routes.push(r.route);
    for (const r of fps) get(r.app).fingerprints.push(r.fingerprint);
    return { day: dayStart(now), apps: byApp };
  }

  // ------------------------------------------------------------------ retention
  async function prune({ hourlyDays, dailyDays, errorDays }, now = Date.now()) {
    const hourCut = iso(now - hourlyDays * DAY);
    const dayCut = iso(dayStart(now) - dailyDays * DAY);
    const errCut = iso(dayStart(now) - errorDays * DAY);
    let removed = 0;
    for (const t of ["vitals_hourly", "views_hourly", "errors_hourly"]) removed += (await sql.unsafe(`DELETE FROM ${t} WHERE bucket < $1`, [hourCut])).count;
    for (const t of ["vitals_daily", "views_daily"]) removed += (await sql.unsafe(`DELETE FROM ${t} WHERE bucket < $1`, [dayCut])).count;
    removed += (await sql`DELETE FROM errors_daily WHERE bucket < ${errCut}`).count;
    return removed;
  }

  // ------------------------------------------------------------------ summary for Container Health
  async function rangeData(grain, since) {
    const v = table("vitals", grain);
    const vitals = await sql.unsafe(
      `SELECT app, route, metric, device, u.i::int AS i, sum(u.h)::int AS h
         FROM ${v} v, unnest(v.hist) WITH ORDINALITY AS u(h, i)
        WHERE bucket >= $1 GROUP BY 1, 2, 3, 4, 5`,
      [iso(since)],
    );
    const views = await sql.unsafe(`SELECT app, route, device, sum(n)::int AS n FROM ${table("views", grain)} WHERE bucket >= $1 GROUP BY 1, 2, 3`, [iso(since)]);
    const errors = await sql.unsafe(
      `SELECT app, kind, fingerprint, route, name, message, source, sum(n)::int AS n, max(last_seen) AS last_seen
         FROM ${table("errors", grain)} WHERE bucket >= $1 GROUP BY 1, 2, 3, 4, 5, 6, 7`,
      [iso(since)],
    );
    return { vitals, views, errors };
  }

  async function summary({ now = Date.now(), topRoutes = 10, topErrors = 10 } = {}) {
    const today0 = dayStart(now);
    const ranges = { "24h": ["hour", now - DAY], "7d": ["day", today0 - 6 * DAY], "30d": ["day", today0 - 29 * DAY] };
    const apps = {};
    const appOf = (name) => (apps[name] ||= { ranges: {}, daily: [] });
    for (const name of await listApps()) appOf(name);

    for (const [label, [grain, since]] of Object.entries(ranges)) {
      const { vitals, views, errors } = await rangeData(grain, since);
      const per = new Map();
      const ofApp = (name) => per.get(name) || per.set(name, { views: 0, devices: { mobile: 0, desktop: 0 }, hist: {}, routes: new Map(), errors: [] }).get(name);
      const routeOf = (a, route) => a.routes.get(route) || a.routes.set(route, { route, views: 0, hist: {} }).get(route);
      const addHist = (target, metric, i, h) => {
        const arr = (target[metric] ||= new Array(12).fill(0));
        arr[i - 1] += h;
      };
      for (const r of views) {
        const a = ofApp(r.app);
        a.views += r.n;
        a.devices[r.device] = (a.devices[r.device] || 0) + r.n;
        routeOf(a, r.route).views += r.n;
      }
      for (const r of vitals) {
        const a = ofApp(r.app);
        addHist(a.hist, r.metric, r.i, r.h);
        addHist((a.hist[r.device] ||= {}), r.metric, r.i, r.h);
        addHist(routeOf(a, r.route).hist, r.metric, r.i, r.h);
      }
      for (const r of errors) ofApp(r.app).errors.push(r);

      for (const [name, a] of per) {
        const stat = (hist, metric) => {
          const h = hist?.[metric];
          const n = h ? h.reduce((x, y) => x + y, 0) : 0;
          return n ? { n, p50: round(metric, quantile(metric, h, 0.5)), p75: round(metric, quantile(metric, h, 0.75)), p95: round(metric, quantile(metric, h, 0.95)) } : null;
        };
        const vitalsOut = {};
        for (const m of METRICS) {
          const all = stat(a.hist, m);
          if (all) vitalsOut[m] = { ...all, mobile: stat(a.hist.mobile, m), desktop: stat(a.hist.desktop, m) };
        }
        const routes = [...a.routes.values()]
          .map((r) => ({ route: r.route, views: r.views, LCP: stat(r.hist, "LCP")?.p75 ?? null, NAV: stat(r.hist, "NAV")?.p75 ?? null, INP: stat(r.hist, "INP")?.p75 ?? null }))
          .sort((x, y) => y.views - x.views || x.route.localeCompare(y.route))
          .slice(0, topRoutes);
        const errs = a.errors
          .sort((x, y) => y.n - x.n || y.last_seen - x.last_seen)
          .slice(0, topErrors)
          .map((e) => ({ kind: e.kind, name: e.name, message: e.message, source: e.source, route: e.route, count: e.n, last_seen: new Date(e.last_seen).toISOString() }));
        const errorCount = a.errors.reduce((x, e) => x + e.n, 0);
        appOf(name).ranges[label] = { views: a.views, devices: a.devices, vitals: vitalsOut, routes, errors: errs, error_count: errorCount };
      }
    }

    // Daily series for the last 30 days: views and LCP p75
    const since = iso(today0 - 29 * DAY);
    const dviews = await sql`SELECT app, bucket, sum(n)::int AS n FROM views_daily WHERE bucket >= ${since} GROUP BY 1, 2`;
    const dlcp = await sql`
      SELECT app, bucket, u.i::int AS i, sum(u.h)::int AS h
        FROM vitals_daily v, unnest(v.hist) WITH ORDINALITY AS u(h, i)
       WHERE bucket >= ${since} AND metric = 'LCP' GROUP BY 1, 2, 3`;
    const series = new Map();
    const point = (app, bucket) => {
      const k = app + "|" + new Date(bucket).getTime();
      return series.get(k) || series.set(k, { app, day: new Date(bucket).getTime(), views: 0, hist: new Array(12).fill(0) }).get(k);
    };
    for (const r of dviews) point(r.app, r.bucket).views += r.n;
    for (const r of dlcp) point(r.app, r.bucket).hist[r.i - 1] += r.h;
    for (const p of [...series.values()].sort((a, b) => a.day - b.day)) {
      appOf(p.app).daily.push({ day: iso(p.day), views: p.views, lcp_p75: round("LCP", quantile("LCP", p.hist, 0.75)) });
    }
    return { generated_at: iso(now), apps };
  }

  const ping = () => sql`SELECT 1`;
  const close = () => sql.end({ timeout: 5 });

  return { sql, migrate, findApp, listApps, hasApp, rotate, removeApp, flush, today, prune, summary, ping, close };
}

function round(metric, v) {
  if (v == null) return null;
  return metric === "CLS" ? Math.round(v * 1000) / 1000 : Math.round(v);
}
