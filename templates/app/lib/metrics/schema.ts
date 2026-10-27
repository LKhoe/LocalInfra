// Light, anonymous usage metrics: what the browser may send to /api/metrics. The same rules as
// LocalInfra/metrics/schema.mjs, which checks everything again. Copied from
// LocalInfra/templates/app/lib/metrics/ (keep the copies in sync).
//
//   { v: 1, device: "mobile" | "desktop",
//     events: [ { t: "view",  route }
//             | { t: "vital", route, name: LCP|INP|CLS|FCP|TTFB|NAV, value }
//             | { t: "error", route, name, message, source? } ] }
//
// route is a pattern ("/recipes/[id]"), never a real path. No IP, user agent, language,
// referrer, user or session id, cookie or client timestamp.

export const METRICS = ["LCP", "INP", "CLS", "FCP", "TTFB", "NAV"] as const;
export type MetricName = (typeof METRICS)[number];
export type Device = "mobile" | "desktop";
export type MetricsEvent =
  | { t: "view"; route: string }
  | { t: "vital"; route: string; name: MetricName; value: number }
  | { t: "error"; route: string; kind: "client" | "server"; name: string; message: string; source: string };
export type MetricsBatch = { device: Device; events: MetricsEvent[] };

export const MAX_BODY_BYTES = 8 * 1024;
export const MAX_EVENTS = 20;

const SEGMENT = String.raw`(?:[A-Za-z0-9_\-.~]+|\[{1,2}(?:\.\.\.)?[A-Za-z0-9_]+\]{1,2})`;
const ROUTE = new RegExp(`^/(?:${SEGMENT}(?:/${SEGMENT})*)?$`);
const NAME = /^[A-Za-z][A-Za-z0-9_.]{0,39}$/;
const SOURCE = /^[A-Za-z0-9_\-.~[\]]{1,60}(?::\d{1,7}){0,2}$/;

// Next.js gives server errors the route with its groups ("/(app)/recipes/[id]"): drop them
export function cleanRoute(route: unknown): string | null {
  if (typeof route !== "string") return null;
  const r = route.replace(/\/\([^/]*\)/g, "") || "/";
  return r.length <= 120 && r.split("/").length <= 9 && ROUTE.test(r) ? r : null;
}

// Personal data that can hide in an error message
export function scrub(text: unknown, max = 160): string {
  return String(text)
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "<email>")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")
    .replace(/\b(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{16,}\b/g, "<id>")
    .replace(/\d{4,}/g, "<n>")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, max);
}

const MAX_VALUE: Partial<Record<MetricName, number>> = { CLS: 100 };

// A batch from the browser. Anything outside the schema rejects the whole batch. Errors from
// the browser are always kind "client": only the server reports "server" errors.
export function parseBrowserBatch(body: unknown): MetricsBatch | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (b.v !== 1) return null;
  const device = b.device;
  if (device !== "mobile" && device !== "desktop") return null;
  if (!Array.isArray(b.events) || !b.events.length || b.events.length > MAX_EVENTS) return null;
  const events: MetricsEvent[] = [];
  for (const raw of b.events) {
    if (!raw || typeof raw !== "object") return null;
    const e = raw as Record<string, unknown>;
    const route = cleanRoute(e.route);
    if (!route) return null;
    if (e.t === "view") {
      events.push({ t: "view", route });
    } else if (e.t === "vital") {
      const name = e.name as MetricName;
      const value = e.value;
      if (!METRICS.includes(name)) return null;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > (MAX_VALUE[name] ?? 600000)) return null;
      events.push({ t: "vital", route, name, value });
    } else if (e.t === "error") {
      if (typeof e.message !== "string") return null;
      events.push({
        t: "error",
        route,
        kind: "client",
        name: typeof e.name === "string" && NAME.test(e.name) ? e.name : "Error",
        message: scrub(e.message),
        source: typeof e.source === "string" && SOURCE.test(e.source) ? e.source : "",
      });
    } else {
      return null;
    }
  }
  return { device, events };
}
