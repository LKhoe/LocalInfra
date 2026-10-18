// LocalInfra LLM gateway: one OpenAI-compatible endpoint for every app on the Pi.
//
//   POST /v1/chat/completions   model = "simple" | "medium" | "hard" (the tier, never a model name)
//   GET  /v1/models             the tiers and the models behind them
//   GET  /v1/usage              the calling app's spend and limits
//   GET  /health                for the healthcheck (no auth)
//
// simple → free OpenRouter models, then the local model (Ollama) when they fail. Costs nothing.
// medium → cheap paid models; hard → good (medium-cost) paid models. Both count against the
//          app's limits: a monthly budget in USD and a number of paid calls per day.
//
// Apps authenticate with their own key (Authorization: Bearer llm_...), made by
// scripts/new-project.sh --llm. Only the gateway holds the OpenRouter key.
import http from "node:http";
import { openStore, PAID_TIERS } from "./store.mjs";

export const TIERS = ["simple", "medium", "hard"];

// Only what a chat completion needs: anything else (models, provider, plugins, ...) could
// pick another model or route around the tier, so it never reaches OpenRouter.
const PASSTHROUGH = [
  "messages", "temperature", "top_p", "stop", "seed", "response_format",
  "tools", "tool_choice", "parallel_tool_calls", "frequency_penalty", "presence_penalty", "reasoning",
];
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const list = (value, fallback) => (value || fallback).split(",").map((s) => s.trim()).filter(Boolean);
const number = (value, fallback) => (value === undefined || value === "" ? fallback : Number(value));

export function configFromEnv(env = process.env) {
  const config = {
    port: number(env.PORT, 4000),
    dbPath: env.LLM_DB || "/data/llm.sqlite",
    openrouterUrl: (env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, ""),
    openrouterKey: env.OPENROUTER_API_KEY || "",
    tiers: {
      simple: list(env.LLM_SIMPLE_MODELS, "google/gemma-4-31b-it:free,openrouter/free"),
      medium: list(env.LLM_MEDIUM_MODELS, "anthropic/claude-haiku-5.5,openai/gpt-6-luna"),
      hard: list(env.LLM_HARD_MODELS, "anthropic/claude-sonnet-5.5,openai/gpt-6.1-sol"),
    },
    // Ollama in the same container (llm/start.sh). Empty = no local fallback.
    localUrl: (env.LLM_LOCAL_URL ?? "http://127.0.0.1:11434").replace(/\/$/, ""),
    localModel: env.LLM_LOCAL_MODEL || "gemma3:1b",
    defaults: {
      monthlyUsd: number(env.LLM_DEFAULT_MONTHLY_USD, 2),
      dailyPaidCalls: number(env.LLM_DEFAULT_DAILY_PAID_CALLS, 200),
    },
    maxTokens: number(env.LLM_MAX_TOKENS, 8192),
    timeouts: {
      free: number(env.LLM_FREE_TIMEOUT_MS, 45000),
      paid: number(env.LLM_TIMEOUT_MS, 120000),
      local: number(env.LLM_LOCAL_TIMEOUT_MS, 180000),
    },
    keepDays: number(env.LLM_KEEP_DAYS, 400),
  };
  // The simple tier must never spend money, whatever is in .env
  const paid = config.tiers.simple.filter((m) => !m.endsWith(":free") && m !== "openrouter/free");
  if (paid.length) throw new Error(`LLM_SIMPLE_MODELS may only list free models (":free" or openrouter/free), not: ${paid.join(", ")}`);
  for (const t of TIERS) if (!config.tiers[t].length && t !== "simple") throw new Error(`LLM_${t.toUpperCase()}_MODELS is empty`);
  return config;
}

class UpstreamError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function postJson(url, headers, body, timeoutMs) {
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const why = err.name === "TimeoutError" ? `no answer after ${Math.round(timeoutMs / 1000)}s` : err.cause?.message || err.message;
    throw new UpstreamError(why, 504);
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON: handled below
  }
  if (!res.ok) throw new UpstreamError(`${res.status} ${(json?.error?.message || text).slice(0, 300)}`, res.status);
  if (!json) throw new UpstreamError("answer is not JSON", 502);
  // OpenRouter reports some provider failures with a 200
  const error = json.error || json.choices?.[0]?.error;
  if (error) throw new UpstreamError(String(error.message || JSON.stringify(error)).slice(0, 300), Number(error.code) || 502);
  if (!json.choices?.length) throw new UpstreamError("answer has no choices", 502);
  return json;
}

export function createGateway(config, store = openStore(config.dbPath, config.defaults)) {
  // $/token per model, from OpenRouter's public list: only used when an answer has no usage.cost
  const pricing = new Map();
  async function refreshPricing() {
    try {
      const res = await fetch(config.openrouterUrl + "/models", { signal: AbortSignal.timeout(15000) });
      const { data } = await res.json();
      for (const m of data || []) pricing.set(m.id, { prompt: Number(m.pricing?.prompt) || 0, completion: Number(m.pricing?.completion) || 0 });
    } catch (err) {
      console.warn("[llm] could not load OpenRouter prices:", err.message);
    }
  }
  function estimateCost(tier, model, usage) {
    const known = [model, ...config.tiers[tier]].map((m) => pricing.get(m)).filter(Boolean);
    if (!known.length || !usage) return 0;
    // the answer's own model when known, else the priciest of the tier (never under-count)
    const p = pricing.get(model) || known.reduce((a, b) => (a.completion > b.completion ? a : b));
    return (usage.prompt_tokens || 0) * p.prompt + (usage.completion_tokens || 0) * p.completion;
  }

  function openrouter(app, tier, payload) {
    if (!config.openrouterKey) throw new UpstreamError("OPENROUTER_API_KEY is not set", 503);
    const models = config.tiers[tier];
    return postJson(
      config.openrouterUrl + "/chat/completions",
      { Authorization: "Bearer " + config.openrouterKey, "X-Title": "LocalInfra " + app.name },
      // "models": OpenRouter tries them in order when one is down or rate-limited
      { ...payload, model: models[0], models, usage: { include: true }, user: app.name },
      tier === "simple" ? config.timeouts.free : config.timeouts.paid,
    ).then((json) => ({
      json,
      provider: "openrouter",
      model: json.model || models[0],
      cost: typeof json.usage?.cost === "number" ? json.usage.cost : estimateCost(tier, json.model, json.usage),
    }));
  }

  async function local(payload) {
    if (!config.localUrl) throw new UpstreamError("no local model (LLM_LOCAL_URL is empty)", 503);
    const { reasoning, ...rest } = payload;
    const json = await postJson(config.localUrl + "/v1/chat/completions", {}, { ...rest, model: config.localModel }, config.timeouts.local);
    json.model = "local/" + config.localModel;
    return { json, provider: "local", model: json.model, cost: 0 };
  }

  async function complete(app, tier, payload) {
    if (tier !== "simple") return { ...(await openrouter(app, tier, payload)), note: null };
    let freeFailure = null;
    if (config.tiers.simple.length && config.openrouterKey) {
      try {
        return { ...(await openrouter(app, tier, payload)), note: null };
      } catch (err) {
        freeFailure = "free models failed (" + err.message + ")";
      }
    }
    try {
      return { ...(await local(payload)), note: freeFailure && freeFailure + ", used the local model" };
    } catch (err) {
      throw new UpstreamError((freeFailure ? freeFailure + "; " : "") + "local model failed (" + err.message + ")", 502);
    }
  }

  async function chat(app, body) {
    const tier = TIERS.find((t) => body.model === t || body.model === "localinfra/" + t);
    if (!tier) return [400, error(`"model" must be one of ${TIERS.join(", ")} (got ${JSON.stringify(body.model)})`, "invalid_tier")];
    if (body.stream) return [400, error("Streaming is not supported: send stream: false", "stream_unsupported")];
    if (!Array.isArray(body.messages) || !body.messages.length) return [400, error('"messages" must be a non-empty array', "invalid_request")];

    if (PAID_TIERS.includes(tier)) {
      const block = store.paidBlock(app);
      if (block) {
        console.log(`[llm] ${app.name} ${tier} blocked: ${block.code}`);
        return [429, { error: { message: block.message, type: "limit", code: block.code }, localinfra: { tier, usage: block.usage } }];
      }
    }

    const payload = {};
    for (const k of PASSTHROUGH) if (body[k] !== undefined) payload[k] = body[k];
    const asked = Number(body.max_tokens ?? body.max_completion_tokens) || config.maxTokens;
    payload.max_tokens = Math.min(asked, config.maxTokens);

    const started = Date.now();
    try {
      const r = await complete(app, tier, payload);
      const usage = r.json.usage || {};
      const ms = Date.now() - started;
      store.record({ app: app.name, at: started, tier, provider: r.provider, model: r.model, ok: true,
        promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, cost: r.cost, ms, error: r.note });
      console.log(`[llm] ${app.name} ${tier} ${r.model} ${usage.prompt_tokens ?? "?"}+${usage.completion_tokens ?? "?"} tok $${r.cost.toFixed(6)} ${ms}ms` + (r.note ? " | " + r.note : ""));
      r.json.localinfra = { tier, provider: r.provider, cost_usd: r.cost, ...(r.note ? { note: r.note } : {}) };
      return [200, r.json, { "X-LLM-Tier": tier, "X-LLM-Provider": r.provider, "X-LLM-Cost": String(r.cost) }];
    } catch (err) {
      const ms = Date.now() - started;
      store.record({ app: app.name, at: started, tier, ok: false, ms, error: err.message });
      console.log(`[llm] ${app.name} ${tier} FAILED ${ms}ms: ${err.message}`);
      // A request OpenRouter rejects as malformed is the app's to fix; everything else is ours
      const status = [400, 413, 422].includes(err.status) ? err.status : err.status === 504 ? 504 : 502;
      return [status, error(`${tier} tier failed: ${err.message}`, "upstream_error")];
    }
  }

  const error = (message, code) => ({ error: { message, type: code === "upstream_error" ? "upstream" : "invalid_request_error", code } });

  function models() {
    const describe = (id) => ({
      id,
      object: "model",
      owned_by: "localinfra",
      paid: PAID_TIERS.includes(id),
      models: config.tiers[id],
      ...(id === "simple" && config.localUrl ? { fallback: "local/" + config.localModel } : {}),
    });
    return { object: "list", data: TIERS.map(describe) };
  }

  function usage(app) {
    const u = store.usage(app);
    return { ...u, this_month: store.breakdown(app.name, Date.parse(u.month.since)) };
  }

  // "ready", "downloading" (Ollama is up, the model isn't there yet) or "down"
  async function localStatus() {
    if (!config.localUrl) return { model: null, state: "off" };
    try {
      const res = await fetch(config.localUrl + "/api/tags", { signal: AbortSignal.timeout(2000) });
      const { models = [] } = await res.json();
      const want = config.localModel.includes(":") ? config.localModel : config.localModel + ":latest";
      return { model: config.localModel, state: models.some((m) => m.name === want) ? "ready" : "downloading" };
    } catch {
      return { model: config.localModel, state: "down" };
    }
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw Object.assign(new Error("Request body too large"), { status: 413 });
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw Object.assign(new Error("Request body is not JSON"), { status: 400 });
    }
  }

  async function route(req) {
    const path = new URL(req.url, "http://x").pathname.replace(/\/$/, "");
    if (req.method === "GET" && (path === "/health" || path === "/healthz")) {
      store.list(); // the database answers
      return [200, { status: "ok", openrouter: Boolean(config.openrouterKey), local: await localStatus() }];
    }

    const key = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const app = store.findByKey(key);
    if (!app) return [401, error("Missing or unknown LLM key (Authorization: Bearer llm_...). Provision one with scripts/new-project.sh <app> --llm", "invalid_api_key")];

    if (req.method === "GET" && path === "/v1/models") return [200, models()];
    if (req.method === "GET" && path === "/v1/usage") return [200, usage(app)];
    if (req.method === "POST" && path === "/v1/chat/completions") return chat(app, await readBody(req));
    return [404, error(`No route ${req.method} ${path}`, "not_found")];
  }

  const server = http.createServer(async (req, res) => {
    let status, body, headers;
    try {
      [status, body, headers] = await route(req);
    } catch (err) {
      status = err.status || 500;
      body = error(err.message, "invalid_request");
      if (status === 500) console.error("[llm]", err);
    }
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
    res.end(JSON.stringify(body));
  });
  // A slow local answer on the Pi can take minutes
  server.requestTimeout = config.timeouts.free + config.timeouts.local + 30000;

  const timers = [];
  server.on("listening", () => {
    refreshPricing();
    timers.push(setInterval(refreshPricing, 12 * 3600 * 1000).unref());
    const pruned = store.prune(config.keepDays);
    if (pruned) console.log(`[llm] pruned ${pruned} calls older than ${config.keepDays} days`);
    timers.push(setInterval(() => store.prune(config.keepDays), 24 * 3600 * 1000).unref());
  });
  server.on("close", () => timers.forEach(clearInterval));

  return { server, store, refreshPricing };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = configFromEnv();
  const { server } = createGateway(config);
  server.listen(config.port, () => {
    console.log(`[llm] listening on :${config.port}`);
    for (const t of TIERS) console.log(`[llm]   ${t}: ${config.tiers[t].join(" → ") || "(none)"}${t === "simple" && config.localUrl ? " → local/" + config.localModel : ""}`);
    if (!config.openrouterKey) console.warn("[llm] OPENROUTER_API_KEY is not set: only the local model works");
  });
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.close(() => process.exit(0)));
}
