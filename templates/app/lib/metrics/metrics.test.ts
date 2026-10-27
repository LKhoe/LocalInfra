// Copied from LocalInfra/templates/app/lib/metrics/ (keep the copies in sync).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanRoute, parseBrowserBatch, scrub } from "./schema";
import { toRoutePattern } from "./route-pattern";
import { createRateLimiter } from "./rate-limit";
import { reportServerError, sendToMetrics } from "./forward";

describe("toRoutePattern", () => {
  it("replaces param values by their names", () => {
    expect(toRoutePattern("/xadrez/AB12", { code: "AB12" })).toBe("/xadrez/[code]");
    expect(toRoutePattern("/u/leo/lists", { username: "leo" })).toBe("/u/[username]/lists");
    expect(toRoutePattern("/docs/a/b", { slug: ["a", "b"] })).toBe("/docs/[...slug]");
    expect(toRoutePattern("/", {})).toBe("/");
    expect(toRoutePattern("/receitas/caf%C3%A9", { id: "café" })).toBe("/receitas/[id]");
  });

  it("hides static-looking ids and odd segments", () => {
    expect(toRoutePattern("/recipes/123456", {})).toBe("/recipes/[x]");
    expect(toRoutePattern("/t/abcdef0123456789abcd", {})).toBe("/t/[x]");
    expect(toRoutePattern("/a b/c", {})).toBe("/[x]/c");
    expect(toRoutePattern("/a?x=1#y", {})).toBe("/a");
    expect(cleanRoute(toRoutePattern("/1/2/3/4/5/6/7/8/9/10", {}))).not.toBeNull();
  });
});

describe("parseBrowserBatch", () => {
  const ok = { v: 1, device: "mobile", events: [{ t: "view", route: "/" }] };

  it("accepts a good batch and forces client errors", () => {
    const b = parseBrowserBatch({
      ...ok,
      events: [
        { t: "vital", route: "/x/[id]", name: "LCP", value: 1200 },
        { t: "error", route: "/", kind: "server", name: "TypeError", message: "for a@b.com", source: "page.js:3" },
      ],
    });
    expect(b?.events[1]).toEqual({ t: "error", route: "/", kind: "client", name: "TypeError", message: "for <email>", source: "page.js:3" });
  });

  it("rejects anything outside the schema", () => {
    expect(parseBrowserBatch(ok)).not.toBeNull();
    for (const bad of [
      null,
      { ...ok, v: 2 },
      { ...ok, device: "tv" },
      { ...ok, events: [] },
      { ...ok, events: Array(21).fill({ t: "view", route: "/" }) },
      { ...ok, events: [{ t: "view", route: "/a?b=1" }] },
      { ...ok, events: [{ t: "vital", route: "/", name: "LCP", value: -5 }] },
      { ...ok, events: [{ t: "vital", route: "/", name: "FID", value: 5 }] },
      { ...ok, events: [{ t: "error", route: "/", message: 1 }] },
      { ...ok, events: [{ t: "x", route: "/" }] },
    ]) {
      expect(parseBrowserBatch(bad)).toBeNull();
    }
  });

  it("scrubs messages", () => {
    expect(scrub("see https://x.y/z?token=1 and 555123456")).toBe("see <url> and <n>");
    expect(scrub("a".repeat(300))).toHaveLength(160);
  });
});

describe("createRateLimiter", () => {
  it("allows up to the limit per window and key", () => {
    const allow = createRateLimiter({ limit: 2, windowMs: 1000 });
    expect([allow("a", 0), allow("a", 1), allow("a", 2), allow("b", 2)]).toEqual([true, true, false, true]);
    expect(allow("a", 1000)).toBe(true);
  });

  it("stays bounded in memory", () => {
    const allow = createRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 3 });
    for (let i = 0; i < 10; i++) expect(allow("k" + i, 0)).toBe(true);
  });
});

describe("forward", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("does nothing without METRICS_URL / METRICS_API_KEY", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("METRICS_URL", "");
    await sendToMetrics({ device: "mobile", events: [{ t: "view", route: "/" }] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends server errors with the route pattern and a scrubbed message", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("METRICS_URL", "http://localinfra-metrics:4100/");
    vi.stubEnv("METRICS_API_KEY", "mx_test");
    await reportServerError(new TypeError("no row for ana@x.com 98765"), { routePath: "/(app)/recipes/[id]/page" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localinfra-metrics:4100/v1/events");
    expect(init.headers.Authorization).toBe("Bearer mx_test");
    expect(JSON.parse(init.body).events[0]).toEqual({
      t: "error", route: "/recipes/[id]", kind: "server", name: "TypeError", message: "no row for <email> <n>", source: "",
    });
  });

  it("never throws when the service is down", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    vi.stubEnv("METRICS_URL", "http://localinfra-metrics:4100");
    vi.stubEnv("METRICS_API_KEY", "mx_test");
    await expect(reportServerError("x", { routePath: "/api/things/route" })).resolves.toBeUndefined();
  });
});
