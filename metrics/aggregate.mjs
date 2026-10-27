// In-memory aggregation between two flushes: nothing raw is ever stored. Every event lands in
// one hourly and one daily row (count, sum and histogram for vitals), and drain() hands the
// rows to the store, which adds them to what's already there.
//
// Cardinality caps keep a buggy or hostile app from filling the database: per app and per day,
// at most maxRoutes routes (the rest count as "(other)") and maxErrors error fingerprints (the
// rest count as one "(other)" error).
import { createHash } from "node:crypto";
import { BUCKETS, bucketOf } from "./schema.mjs";

export const OTHER = "(other)";
const HOUR = 3600 * 1000;

export const hourStart = (at) => Math.floor(at / HOUR) * HOUR;
// Midnight in the container's time zone (TZ)
export function dayStart(at) {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export const fingerprint = (e) => createHash("sha1").update([e.kind, e.name, e.message, e.source].join("\n")).digest("hex").slice(0, 16);

export function createAggregator({ maxRoutes = 60, maxErrors = 100 } = {}) {
  let vitals = new Map(); // key → { app, bucket, grain, route, metric, device, n, sum, hist }
  let views = new Map();
  let errors = new Map();
  // `${app}|${day}` → Set of routes / fingerprints seen that day (seeded from the store at start)
  const routesSeen = new Map();
  const errorsSeen = new Map();
  let pending = 0;

  function capped(seen, app, day, value, max) {
    const k = app + "|" + day;
    let set = seen.get(k);
    if (!set) {
      // a new day: forget the older ones
      for (const key of seen.keys()) if (key.startsWith(app + "|")) seen.delete(key);
      set = new Set();
      seen.set(k, set);
    }
    if (set.has(value)) return value;
    if (set.size >= max) return OTHER;
    set.add(value);
    return value;
  }

  function bump(map, key, init, update) {
    let row = map.get(key);
    if (!row) map.set(key, (row = init()));
    update(row);
  }

  function add(app, device, events, at = Date.now()) {
    const grains = [["hour", hourStart(at)], ["day", dayStart(at)]];
    const day = grains[1][1];
    for (const e of events) {
      const route = capped(routesSeen, app, day, e.route, maxRoutes);
      for (const [grain, bucket] of grains) {
        const base = { app, grain, bucket, route };
        if (e.t === "view") {
          bump(views, [app, grain, bucket, route, device].join("|"), () => ({ ...base, device, n: 0 }), (r) => r.n++);
        } else if (e.t === "vital") {
          bump(
            vitals,
            [app, grain, bucket, route, e.name, device].join("|"),
            () => ({ ...base, metric: e.name, device, n: 0, sum: 0, hist: new Array(BUCKETS[e.name].length + 1).fill(0) }),
            (r) => {
              r.n++;
              r.sum += e.value;
              r.hist[bucketOf(e.name, e.value)]++;
            },
          );
        } else if (e.t === "error") {
          let fp = capped(errorsSeen, app, day, fingerprint(e), maxErrors);
          const other = fp === OTHER;
          bump(
            errors,
            [app, grain, bucket, e.kind, fp, route].join("|"),
            () => ({
              ...base, kind: e.kind, fingerprint: fp,
              name: other ? OTHER : e.name, message: other ? "more distinct errors than the daily cap" : e.message,
              source: other ? "" : e.source, n: 0, last_seen: at,
            }),
            (r) => {
              r.n++;
              r.last_seen = Math.max(r.last_seen, at);
            },
          );
        }
      }
      pending++;
    }
  }

  // Routes and fingerprints already in the database for today, so a restart doesn't reset the caps
  function seed(app, day, routes, fingerprints) {
    routesSeen.set(app + "|" + day, new Set(routes));
    errorsSeen.set(app + "|" + day, new Set(fingerprints));
  }

  function drain() {
    const out = { vitals: [...vitals.values()], views: [...views.values()], errors: [...errors.values()], events: pending };
    vitals = new Map();
    views = new Map();
    errors = new Map();
    pending = 0;
    return out;
  }

  // Put rows back after a failed flush (they're added to whatever came in meanwhile)
  function restore(rows) {
    for (const r of rows.views) bump(views, [r.app, r.grain, r.bucket, r.route, r.device].join("|"), () => ({ ...r, n: 0 }), (x) => (x.n += r.n));
    for (const r of rows.vitals) {
      bump(vitals, [r.app, r.grain, r.bucket, r.route, r.metric, r.device].join("|"), () => ({ ...r, n: 0, sum: 0, hist: r.hist.map(() => 0) }), (x) => {
        x.n += r.n;
        x.sum += r.sum;
        r.hist.forEach((h, i) => (x.hist[i] += h));
      });
    }
    for (const r of rows.errors) {
      bump(errors, [r.app, r.grain, r.bucket, r.kind, r.fingerprint, r.route].join("|"), () => ({ ...r, n: 0 }), (x) => {
        x.n += r.n;
        x.last_seen = Math.max(x.last_seen, r.last_seen);
      });
    }
    pending += rows.events;
  }

  return { add, seed, drain, restore, get pending() { return pending; } };
}
