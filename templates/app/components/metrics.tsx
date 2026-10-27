"use client";

// Light, anonymous usage metrics (LocalInfra/README.md, "Metrics"). Put <Metrics /> once in the
// root layout. It sends to this app's own /api/metrics: page views, Web Vitals (LCP, INP, CLS,
// FCP, TTFB), the time of in-app navigations (NAV: click → new route painted) and uncaught
// errors. Routes are patterns ("/recipes/[id]"); no cookie, no storage, no id of any kind.
// Copied from LocalInfra/templates/app/components/metrics.tsx.
import { useEffect, useRef } from "react";
import { useParams, usePathname } from "next/navigation";
import { useReportWebVitals } from "next/web-vitals";
import { toRoutePattern } from "@/lib/metrics/route-pattern";
import { MAX_EVENTS, scrub, type MetricsEvent } from "@/lib/metrics/schema";

const ENDPOINT = "/api/metrics";
const FLUSH_MS = 10000;
const MAX_ERRORS_PER_PAGE = 10;

const queue: MetricsEvent[] = [];
let landingRoute = "/"; // LCP, FCP and TTFB belong to the page that was loaded
let currentRoute = "/";
let navStart: number | null = null;
let errorsSent = 0;

const device = () => (window.innerWidth < 768 ? "mobile" : "desktop");

function flush() {
  while (queue.length) {
    const body = JSON.stringify({ v: 1, device: device(), events: queue.splice(0, MAX_EVENTS) });
    // A string is sent as text/plain, which sendBeacon always accepts
    if (!navigator.sendBeacon?.(ENDPOINT, body)) {
      fetch(ENDPOINT, { method: "POST", body, keepalive: true, headers: { "Content-Type": "text/plain" } }).catch(() => {});
    }
  }
}

function push(event: MetricsEvent) {
  queue.push(event);
  if (queue.length >= MAX_EVENTS) flush();
}

function reportError(error: unknown, fallbackMessage?: string, filename?: string, line?: number) {
  if (errorsSent >= MAX_ERRORS_PER_PAGE) return;
  // Only our own scripts: extensions and third-party scripts are not this app's errors
  if (filename && !filename.startsWith(location.origin)) return;
  errorsSent++;
  const file = filename ? filename.split("?")[0].split("/").pop() : "";
  push({
    t: "error",
    route: currentRoute,
    kind: "client",
    name: error instanceof Error ? error.name : "Error",
    message: scrub(error instanceof Error ? error.message : fallbackMessage ?? String(error)),
    source: file ? `${file}${line ? ":" + line : ""}`.slice(0, 60) : "",
  });
}

// Stable reference, as useReportWebVitals expects
const onVital: Parameters<typeof useReportWebVitals>[0] = (metric) => {
  if (!["LCP", "INP", "CLS", "FCP", "TTFB"].includes(metric.name)) return;
  const route = ["LCP", "FCP", "TTFB"].includes(metric.name) ? landingRoute : currentRoute;
  push({ t: "vital", route, name: metric.name as "LCP", value: Math.max(0, metric.value) });
};

export function Metrics() {
  const pathname = usePathname();
  const params = useParams();
  const route = toRoutePattern(pathname, params);
  const first = useRef(true);

  useReportWebVitals(onVital);

  // A page view per route, and the time since the click that started the navigation
  useEffect(() => {
    currentRoute = route;
    if (first.current) {
      first.current = false;
      landingRoute = route;
      push({ t: "view", route });
      return;
    }
    push({ t: "view", route });
    const started = navStart;
    navStart = null;
    if (started === null) return;
    // two frames: the new route has been painted
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const ms = performance.now() - started;
        if (ms < 60000) push({ t: "vital", route, name: "NAV", value: ms });
      }),
    );
  }, [route]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a");
      if (!a || !a.href || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin || url.pathname === location.pathname) return;
      navStart = performance.now();
    };
    const onPop = () => {
      navStart = performance.now();
    };
    const onError = (e: ErrorEvent) => reportError(e.error, e.message, e.filename, e.lineno);
    const onRejection = (e: PromiseRejectionEvent) => reportError(e.reason);
    const onHide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("click", onClick, true);
    window.addEventListener("popstate", onPop);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flush);
    const timer = setInterval(flush, FLUSH_MS);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flush);
      clearInterval(timer);
    };
  }, []);

  return null;
}
