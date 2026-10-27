// Server side: hands batches to LocalInfra's metrics service (localinfra-metrics, on the internal
// network localinfra_metrics) with this app's key. Without METRICS_URL / METRICS_API_KEY (local
// dev) it does nothing. Never throws: metrics must not break a request.
// Copied from LocalInfra/templates/app/lib/metrics/.
import { cleanRoute, scrub, type MetricsBatch } from "./schema";

export async function sendToMetrics(batch: MetricsBatch): Promise<void> {
  const url = process.env.METRICS_URL;
  const key = process.env.METRICS_API_KEY;
  if (!url || !key) return;
  try {
    await fetch(url.replace(/\/$/, "") + "/v1/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(2000),
      cache: "no-store",
    });
  } catch {
    // the service is down or slow: drop the batch
  }
}

// For instrumentation.ts onRequestError: the route pattern Next.js gives ("/(app)/recipes/[id]/page",
// "/api/things/route"; never the real path), the error's name and a scrubbed message. No stack, no request data.
export async function reportServerError(err: unknown, context: { routePath?: string } | undefined): Promise<void> {
  const route = cleanRoute((context?.routePath || "/").replace(/\/(page|route|layout|default)$/, "") || "/") ?? "/[x]";
  const name = err instanceof Error && /^[A-Za-z][A-Za-z0-9_.]{0,39}$/.test(err.name) ? err.name : "Error";
  const message = scrub(err instanceof Error ? err.message : String(err)) || "(no message)";
  await sendToMetrics({ device: "desktop", events: [{ t: "error", route, kind: "server", name, message, source: "" }] });
}
