// What an app may send to localinfra-metrics, checked again here even though the app already
// checked it: the service doesn't trust the apps. A batch with anything outside this schema is
// rejected whole. The same rules live in templates/app/lib/metrics/ for the apps' own route.
//
//   { device: "mobile" | "desktop",
//     events: [ { t: "view",  route }
//             | { t: "vital", route, name: LCP|INP|CLS|FCP|TTFB|NAV, value }
//             | { t: "error", route, kind: client|server, name, message, source? } ] }
//
// No IP, user agent, language, referrer, user or session id, and no client timestamp: the
// service stamps the hour itself. Error messages are scrubbed again (emails, URLs, numbers).

export const METRICS = ["LCP", "INP", "CLS", "FCP", "TTFB", "NAV"];
export const DEVICES = ["mobile", "desktop"];
export const MAX_EVENTS = 50;

// Upper bounds of the histogram buckets (the last bucket has no upper bound): 12 buckets each.
// Milliseconds for everything but CLS, which has no unit.
const MS_BUCKETS = [100, 200, 300, 500, 800, 1200, 1800, 2500, 4000, 6000, 10000];
export const BUCKETS = {
  LCP: MS_BUCKETS, INP: MS_BUCKETS, FCP: MS_BUCKETS, TTFB: MS_BUCKETS, NAV: MS_BUCKETS,
  CLS: [0.01, 0.025, 0.05, 0.075, 0.1, 0.15, 0.2, 0.25, 0.4, 0.6, 1],
};
const MAX_VALUE = { CLS: 100 }; // anything else: 10 minutes in ms

// A route pattern as the app sends it: "/", "/xadrez/[code]", "/recipes/[id]/cook". Never a
// real path with ids in it: the app replaces every dynamic segment by its [param] name.
const ROUTE = /^\/(?:[A-Za-z0-9_\-.~]+|\[{1,2}(?:\.\.\.)?[A-Za-z0-9_]+\]{1,2})?(?:\/(?:[A-Za-z0-9_\-.~]+|\[{1,2}(?:\.\.\.)?[A-Za-z0-9_]+\]{1,2}))*$/;
const NAME = /^[A-Za-z][A-Za-z0-9_.]{0,39}$/;
const SOURCE = /^[A-Za-z0-9_\-.~[\]]{1,60}(?::\d{1,7}){0,2}$/;

// Next.js gives server errors the route with its groups ("/(app)/recipes/[id]"): drop them
export function cleanRoute(route) {
  if (typeof route !== "string") return null;
  const r = route.replace(/\/\([^/]*\)/g, "") || "/";
  return r.length <= 120 && r.split("/").length <= 9 && ROUTE.test(r) ? r : null;
}

// Personal data that can hide in an error message
export function scrub(text, max = 160) {
  return String(text)
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "<email>")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")
    .replace(/\b(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{16,}\b/g, "<id>")
    .replace(/\d{4,}/g, "<n>")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, max);
}

const fail = (why) => ({ ok: false, error: why });

// → { ok: true, device, events } with clean values, or { ok: false, error }
export function parseBatch(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail("body must be an object");
  const device = body.device ?? "desktop";
  if (!DEVICES.includes(device)) return fail("device must be mobile or desktop");
  if (!Array.isArray(body.events) || !body.events.length) return fail("events must be a non-empty array");
  if (body.events.length > MAX_EVENTS) return fail(`at most ${MAX_EVENTS} events per batch`);
  const events = [];
  for (const [i, e] of body.events.entries()) {
    if (!e || typeof e !== "object") return fail(`events[${i}] is not an object`);
    const route = cleanRoute(e.route);
    if (!route) return fail(`events[${i}].route is not a route pattern`);
    if (e.t === "view") {
      events.push({ t: "view", route });
    } else if (e.t === "vital") {
      if (!METRICS.includes(e.name)) return fail(`events[${i}].name must be one of ${METRICS.join(", ")}`);
      const value = e.value;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > (MAX_VALUE[e.name] ?? 600000)) {
        return fail(`events[${i}].value is out of range`);
      }
      events.push({ t: "vital", route, name: e.name, value });
    } else if (e.t === "error") {
      const kind = e.kind ?? "client";
      if (kind !== "client" && kind !== "server") return fail(`events[${i}].kind must be client or server`);
      const name = typeof e.name === "string" && NAME.test(e.name) ? e.name : "Error";
      if (typeof e.message !== "string") return fail(`events[${i}].message must be a string`);
      const source = typeof e.source === "string" && SOURCE.test(e.source) ? e.source : "";
      events.push({ t: "error", route, kind, name, message: scrub(e.message), source });
    } else {
      return fail(`events[${i}].t must be view, vital or error`);
    }
  }
  return { ok: true, device, events };
}

// Which bucket a value falls in
export function bucketOf(metric, value) {
  const bounds = BUCKETS[metric];
  let i = 0;
  while (i < bounds.length && value > bounds[i]) i++;
  return i;
}

// Approximate quantile (0..1) from a histogram, interpolating inside the bucket. The last bucket
// has no upper bound, so a quantile that lands there reports its lower bound.
export function quantile(metric, hist, q) {
  const n = hist.reduce((a, b) => a + b, 0);
  if (!n) return null;
  const bounds = BUCKETS[metric];
  const target = q * n;
  let seen = 0;
  for (let i = 0; i < hist.length; i++) {
    if (seen + hist[i] >= target && hist[i] > 0) {
      const lo = i === 0 ? 0 : bounds[i - 1];
      if (i >= bounds.length) return lo;
      const hi = bounds[i];
      return lo + ((hi - lo) * (target - seen)) / hist[i];
    }
    seen += hist[i];
  }
  return bounds[bounds.length - 1];
}
