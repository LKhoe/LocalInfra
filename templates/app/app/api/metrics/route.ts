// POST /api/metrics: what <Metrics /> sends from the browser (lib/metrics/schema.ts). Public on
// purpose (the data is anonymous), so it is strict: same origin only, at most 8 KB, schema
// checked, 30 requests a minute per client IP and 600 a minute for the whole app. Valid batches
// go to LocalInfra's metrics service after the response. Copied from LocalInfra/templates/app/.
import { after, type NextRequest } from "next/server";
import { MAX_BODY_BYTES, parseBrowserBatch } from "@/lib/metrics/schema";
import { clientIp, createRateLimiter } from "@/lib/metrics/rate-limit";
import { sendToMetrics } from "@/lib/metrics/forward";

const perClient = createRateLimiter({ limit: 30, windowMs: 60000 });
const perApp = createRateLimiter({ limit: 600, windowMs: 60000, maxKeys: 1 });

const empty = (status: number) => new Response(null, { status });

function sameOrigin(req: NextRequest): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function readLimited(req: NextRequest): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return empty(403);
  const type = (req.headers.get("content-type") || "").split(";")[0].trim();
  if (type !== "text/plain" && type !== "application/json") return empty(415);
  if (Number(req.headers.get("content-length")) > MAX_BODY_BYTES) return empty(413);
  if (!perClient(clientIp(req.headers)) || !perApp("app")) return empty(429);

  const text = await readLimited(req);
  if (text === null) return empty(413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return empty(400);
  }
  const batch = parseBrowserBatch(body);
  if (!batch) return empty(400);
  after(() => sendToMetrics(batch));
  return empty(204);
}
