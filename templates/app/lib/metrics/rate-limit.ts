// Fixed-window rate limit in this process's memory. The keys (client IPs) live only here, for at
// most one window, and are never logged or sent anywhere. Copied from LocalInfra/templates/app/lib/metrics/.

export function createRateLimiter({ limit, windowMs, maxKeys = 10000 }: { limit: number; windowMs: number; maxKeys?: number }) {
  const hits = new Map<string, { start: number; count: number }>();
  return function allow(key: string, now = Date.now()): boolean {
    let h = hits.get(key);
    if (!h || now - h.start >= windowMs) {
      if (!h && hits.size >= maxKeys) {
        // full: drop expired windows, and everything if that isn't enough
        for (const [k, v] of hits) if (now - v.start >= windowMs) hits.delete(k);
        if (hits.size >= maxKeys) hits.clear();
      }
      h = { start: now, count: 0 };
      hits.set(key, h);
    }
    h.count++;
    return h.count <= limit;
  };
}

// The client's IP as Cloudflare's tunnel reports it, else the first X-Forwarded-For hop
export function clientIp(headers: Headers): string {
  return headers.get("cf-connecting-ip")?.trim() || headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}
