// Container Health: umbrelOS widgets + a status page for the containers you run
// yourself (LocalInfra, your projects), skipping the ones umbrelOS manages.
//
// Read-only by design: the only Docker API call is GET /containers/json.
// No dependencies; runs on a stock node:alpine image.
import http from "node:http";

const PORT = Number(process.env.PORT || 3000);
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || "/var/run/docker.sock";
// Containers umbrelOS starts carry this compose working dir; yours carry the
// folder you deployed from (e.g. /Users/you/Code/project), so they stay visible.
const EXCLUDE_WORKDIR_PREFIXES = (process.env.EXCLUDE_WORKDIR_PREFIXES || "/opt/umbreld/")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// Opt-out for one-off containers: docker run --label localinfra.health.hide=true ...
const HIDE_LABEL = "localinfra.health.hide";
const REFRESH = process.env.WIDGET_REFRESH || "30s";

const STATES = {
  ok: { rank: 0, emoji: "✅", label: "Healthy" },
  starting: { rank: 1, emoji: "⏳", label: "Starting" },
  unhealthy: { rank: 2, emoji: "⚠️", label: "Unhealthy" },
  stopped: { rank: 3, emoji: "❌", label: "Stopped" },
};

function dockerGet(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: DOCKER_SOCKET, path, method: "GET", timeout: 5000 },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) return reject(new Error(`Docker API ${res.statusCode}`));
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("Docker API timeout")));
    req.on("error", reject);
    req.end();
  });
}

function classify(container) {
  const status = container.Status || "";
  switch (container.State) {
    case "running":
      if (/\(unhealthy\)/.test(status)) return "unhealthy";
      if (/\(health: starting\)/.test(status)) return "starting";
      return "ok";
    case "restarting": // a restart loop is a problem, not progress
      return "unhealthy";
    default: // created, exited, paused, dead, removing
      return "stopped";
  }
}

function isMine(container) {
  const labels = container.Labels || {};
  if (labels[HIDE_LABEL] === "true") return false;
  const workdir = labels["com.docker.compose.project.working_dir"] || "";
  return !EXCLUDE_WORKDIR_PREFIXES.some((prefix) => workdir.startsWith(prefix));
}

const worst = (states) =>
  states.reduce((a, b) => (STATES[b].rank > STATES[a].rank ? b : a), "ok");

async function snapshot() {
  const list = await dockerGet("/containers/json?all=true");
  const containers = list.filter(isMine).map((c) => ({
    name: (c.Names?.[0] || c.Id.slice(0, 12)).replace(/^\//, ""),
    project: c.Labels?.["com.docker.compose.project"] || null,
    state: classify(c),
    status: c.Status || c.State,
    image: c.Image,
  }));

  // One group per compose project; containers outside compose stand alone
  const groups = new Map();
  for (const c of containers) {
    const key = c.project || c.name;
    if (!groups.has(key)) groups.set(key, { name: key, containers: [] });
    groups.get(key).containers.push(c);
  }
  const projects = [...groups.values()]
    .map((g) => ({
      ...g,
      state: worst(g.containers.map((c) => c.state)),
      ok: g.containers.filter((c) => c.state === "ok").length,
      containers: g.containers.sort((a, b) => STATES[b.state].rank - STATES[a.state].rank || a.name.localeCompare(b.name)),
    }))
    // Problems first, so they stay visible in a small widget
    .sort((a, b) => STATES[b.state].rank - STATES[a.state].rank || a.name.localeCompare(b.name));

  const counts = { ok: 0, starting: 0, unhealthy: 0, stopped: 0 };
  for (const c of containers) counts[c.state]++;

  return { projects, containers, counts };
}

// ---------------------------------------------------------------- widgets
// umbrelOS draws these itself (same glass look as the built-in widgets).

async function projectsWidget() {
  try {
    const { projects, containers, counts } = await snapshot();
    return {
      type: "list-emoji",
      refresh: REFRESH,
      link: "",
      count: `${counts.ok}/${containers.length}`,
      items: projects.length
        ? projects.map((p) => ({
            emoji: STATES[p.state].emoji,
            text: `${p.name} ${p.ok}/${p.containers.length}`,
          }))
        : [{ emoji: "🫙", text: "No containers of yours yet" }],
    };
  } catch (error) {
    return {
      type: "list-emoji",
      refresh: REFRESH,
      link: "",
      count: "?",
      items: [{ emoji: "❗", text: `Docker unavailable: ${error.message}` }],
    };
  }
}

// Same shape as the native "Live Usage" widget: three pill cells with an icon
// (any Tabler icon name), a label and a value
async function summaryWidget() {
  let stats = null;
  try {
    stats = totals(await snapshot());
  } catch {
    // shown as dashes below
  }
  const issues = stats ? stats.issues : null;
  return {
    type: "three-stats",
    refresh: REFRESH,
    link: "",
    items: [
      { icon: "box", subtext: "Containers", text: stats ? `${stats.okContainers}/${stats.containers}` : "–" },
      { icon: "stack-2", subtext: "Projects", text: stats ? `${stats.okProjects}/${stats.projects}` : "–" },
      {
        icon: issues === 0 ? "shield-check" : "alert-triangle",
        subtext: "Issues",
        text: issues === null ? "–" : String(issues),
      },
    ],
  };
}

// Two rings that fill up with the healthy share of containers and projects
async function gaugesWidget() {
  let stats = null;
  try {
    stats = totals(await snapshot());
  } catch {
    // empty rings below
  }
  const ring = (title, ok, total) => ({
    title,
    text: stats ? `${ok}/${total}` : "–",
    progress: stats && total > 0 ? Number((ok / total).toFixed(2)) : 0,
  });
  return {
    type: "two-stats-with-guage", // sic: umbrelOS spells it this way
    refresh: REFRESH,
    link: "",
    items: [
      ring("Containers", stats?.okContainers, stats?.containers),
      ring("Projects", stats?.okProjects, stats?.projects),
    ],
  };
}

function totals({ projects, containers, counts }) {
  return {
    containers: containers.length,
    okContainers: counts.ok,
    projects: projects.length,
    okProjects: projects.filter((p) => p.state === "ok").length,
    issues: containers.length - counts.ok,
  };
}

// ---------------------------------------------------------------- status page

const escape = (s) =>
  String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

async function statusPage() {
  let body;
  try {
    const { projects, counts } = await snapshot();
    const tiles = Object.entries(STATES)
      .map(([key, s]) => `<div class="tile"><b>${counts[key]}</b><span>${s.label}</span></div>`)
      .join("");
    const sections = projects.length
      ? projects
          .map(
            (p) => `
      <section>
        <h2>${STATES[p.state].emoji} ${escape(p.name)} <small>${p.ok}/${p.containers.length} healthy</small></h2>
        <ul>${p.containers
          .map(
            (c) => `<li class="${c.state}"><span>${STATES[c.state].emoji}</span><b>${escape(c.name)}</b><em>${escape(c.status)}</em></li>`,
          )
          .join("")}</ul>
      </section>`,
          )
          .join("")
      : `<p class="empty">No containers of yours yet.</p>`;
    body = `<div class="tiles">${tiles}</div>${sections}`;
  } catch (error) {
    body = `<p class="empty">❗ Docker unavailable: ${escape(error.message)}</p>`;
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="15">
<title>Container Health</title>
<style>
  :root { color-scheme: dark; --bg: #0b0b12; --card: rgba(255,255,255,.06); --line: rgba(255,255,255,.1); --muted: rgba(255,255,255,.55); }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; font: 14px/1.4 system-ui, -apple-system, sans-serif; color: #fff;
         background: radial-gradient(1200px 600px at 20% -10%, #3b2a6b 0%, transparent 60%), radial-gradient(900px 500px at 110% 10%, #123a5a 0%, transparent 55%), var(--bg); }
  main { max-width: 760px; margin: 0 auto; padding: 32px 16px; }
  h1 { font-size: 22px; margin: 0 0 4px; } .sub { color: var(--muted); margin: 0 0 24px; }
  .tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 24px; }
  .tile, section { background: var(--card); border: 1px solid var(--line); border-radius: 16px; backdrop-filter: blur(20px); }
  .tile { padding: 14px; text-align: center; } .tile b { display: block; font-size: 24px; } .tile span { color: var(--muted); font-size: 12px; }
  section { padding: 14px 16px; margin-bottom: 12px; }
  h2 { font-size: 15px; margin: 0 0 8px; } h2 small { color: var(--muted); font-weight: 400; margin-left: 6px; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: grid; grid-template-columns: 22px minmax(0, 1fr) auto; gap: 8px; padding: 6px 0; border-top: 1px solid var(--line); align-items: baseline; }
  li b { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } li em { color: var(--muted); font-style: normal; font-size: 12px; text-align: right; }
  li.unhealthy em, li.stopped em { color: #ffb4a8; }
  .empty { color: var(--muted); }
  @media (max-width: 480px) { .tiles { grid-template-columns: repeat(2, 1fr); } li { grid-template-columns: 22px minmax(0, 1fr); } li em { grid-column: 2; text-align: left; } }
</style>
</head>
<body><main>
  <h1>Container Health</h1>
  <p class="sub">Containers you run on this Umbrel (apps managed by umbrelOS are hidden). Refreshes every 15s.</p>
  ${body}
</main></body>
</html>`;
}

// ---------------------------------------------------------------- server

const routes = {
  "/widgets/projects": async () => ({ type: "application/json", body: JSON.stringify(await projectsWidget()) }),
  "/widgets/summary": async () => ({ type: "application/json", body: JSON.stringify(await summaryWidget()) }),
  "/widgets/gauges": async () => ({ type: "application/json", body: JSON.stringify(await gaugesWidget()) }),
  "/healthz": async () => ({ type: "text/plain", body: "ok" }),
  "/": async () => ({ type: "text/html; charset=utf-8", body: await statusPage() }),
};

http
  .createServer(async (req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    const route = req.method === "GET" ? routes[path] : undefined;
    if (!route) {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      return;
    }
    try {
      const { type, body } = await route();
      res.writeHead(200, { "content-type": type, "cache-control": "no-store" }).end(body);
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain" }).end(String(error?.message || error));
    }
  })
  .listen(PORT, () => console.log(`Container Health listening on :${PORT}`));
