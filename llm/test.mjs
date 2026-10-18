// node --test llm/test.mjs — the gateway against fake OpenRouter and Ollama servers.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configFromEnv, createGateway } from "./server.mjs";

// What the fakes do next; each test sets it
const fake = { openrouter: null, local: null, seen: [] };

function fakeServer(name) {
  return http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    if (req.method === "GET" && req.url === "/api/tags") {
      res.end(JSON.stringify({ models: [{ name: "tiny:1b" }] }));
      return;
    }
    if (req.method === "GET" && req.url === "/models") {
      res.end(JSON.stringify({ data: [{ id: "paid/cheap", pricing: { prompt: "0.000001", completion: "0.000002" } }] }));
      return;
    }
    const json = body ? JSON.parse(body) : null;
    fake.seen.push({ name, url: req.url, headers: req.headers, body: json });
    const [status, answer] = fake[name](json);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(answer));
  });
}
const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));
const reply = (model, content, usage = {}) => [200, { model, choices: [{ message: { role: "assistant", content } }], usage }];

let dir, upstream, local, gw, base, key, otherKey;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "llm-test-"));
  upstream = fakeServer("openrouter");
  local = fakeServer("local");
  const [upUrl, localUrl] = await Promise.all([listen(upstream), listen(local)]);
  const config = configFromEnv({
    LLM_DB: join(dir, "llm.sqlite"),
    OPENROUTER_BASE_URL: upUrl,
    OPENROUTER_API_KEY: "sk-or-test",
    LLM_SIMPLE_MODELS: "free/a:free,openrouter/free",
    LLM_MEDIUM_MODELS: "paid/cheap",
    LLM_HARD_MODELS: "paid/good",
    LLM_LOCAL_URL: localUrl,
    LLM_LOCAL_MODEL: "tiny:1b",
    LLM_DEFAULT_MONTHLY_USD: "0.01",
    LLM_DEFAULT_DAILY_PAID_CALLS: "3",
    LLM_MAX_TOKENS: "1000",
  });
  gw = createGateway(config);
  base = await listen(gw.server);
  key = gw.store.add("app_one");
  otherKey = gw.store.add("app_two");
});

after(() => {
  for (const s of [gw.server, upstream, local]) s.close();
  gw.store.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  fake.seen = [];
  fake.openrouter = () => reply("free/a:free", "from openrouter", { prompt_tokens: 10, completion_tokens: 5, cost: 0 });
  fake.local = () => reply("tiny:1b", "from local", { prompt_tokens: 10, completion_tokens: 5 });
});

async function chat(body, k = key) {
  const res = await fetch(base + "/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + k, "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], ...body }),
  });
  return { status: res.status, headers: res.headers, json: await res.json() };
}

test("health needs no key; everything else does", async () => {
  const health = await fetch(base + "/health");
  assert.equal(health.status, 200);
  assert.deepEqual((await health.json()).local, { model: "tiny:1b", state: "ready" });
  assert.equal((await chat({ model: "simple" }, "llm_wrong")).status, 401);
  assert.equal((await fetch(base + "/v1/models")).status, 401);
});

test("a paid model in the simple tier is refused at start", () => {
  assert.throws(() => configFromEnv({ LLM_SIMPLE_MODELS: "openai/gpt-6-luna" }), /only list free models/);
});

test("simple: free OpenRouter models, the tier is never a model name upstream", async () => {
  const r = await chat({ model: "simple", models: ["openai/expensive"], provider: { order: ["x"] }, max_tokens: 50000 });
  assert.equal(r.status, 200);
  assert.equal(r.json.choices[0].message.content, "from openrouter");
  assert.deepEqual(r.json.localinfra, { tier: "simple", provider: "openrouter", cost_usd: 0 });
  const sent = fake.seen[0];
  assert.equal(sent.headers.authorization, "Bearer sk-or-test");
  assert.equal(sent.body.model, "free/a:free");
  assert.deepEqual(sent.body.models, ["free/a:free", "openrouter/free"]);
  assert.equal(sent.body.provider, undefined);
  assert.equal(sent.body.max_tokens, 1000, "capped at LLM_MAX_TOKENS");
  assert.equal(sent.body.user, "app_one");
});

test("simple: falls back to the local model when the free models fail", async () => {
  fake.openrouter = () => [429, { error: { message: "rate limited", code: 429 } }];
  const r = await chat({ model: "simple", response_format: { type: "json_object" } });
  assert.equal(r.status, 200);
  assert.equal(r.json.choices[0].message.content, "from local");
  assert.equal(r.json.model, "local/tiny:1b");
  assert.equal(r.json.localinfra.provider, "local");
  assert.match(r.json.localinfra.note, /rate limited/);
  const sent = fake.seen.find((s) => s.name === "local");
  assert.equal(sent.url, "/v1/chat/completions");
  assert.equal(sent.body.model, "tiny:1b");
  assert.deepEqual(sent.body.response_format, { type: "json_object" });
});

test("simple: a 200 carrying an error also falls back", async () => {
  fake.openrouter = () => [200, { error: { message: "provider returned error", code: 502 } }];
  const r = await chat({ model: "simple" });
  assert.equal(r.json.localinfra.provider, "local");
});

test("simple: both failing is a 502 that names both", async () => {
  fake.openrouter = () => [503, { error: { message: "down" } }];
  fake.local = () => [500, { error: { message: "model not found" } }];
  const r = await chat({ model: "simple" });
  assert.equal(r.status, 502);
  assert.match(r.json.error.message, /down.*model not found/);
});

test("unknown tier, streaming and empty messages are refused", async () => {
  assert.equal((await chat({ model: "openai/gpt-6-luna" })).status, 400);
  assert.equal((await chat({ model: "medium", stream: true })).status, 400);
  assert.equal((await chat({ model: "medium", messages: [] })).status, 400);
});

test("medium: paid call, cost recorded, no local fallback", async () => {
  fake.openrouter = () => reply("paid/cheap", "paid answer", { prompt_tokens: 100, completion_tokens: 100, cost: 0.002 });
  const r = await chat({ model: "medium" });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-llm-cost"), "0.002");
  assert.equal(fake.seen[0].body.model, "paid/cheap");

  fake.openrouter = () => [500, { error: { message: "boom" } }];
  const failed = await chat({ model: "medium" });
  assert.equal(failed.status, 502);
  assert.ok(!fake.seen.some((s) => s.name === "local"));
});

test("a request OpenRouter rejects as malformed keeps its 400", async () => {
  fake.openrouter = () => [400, { error: { message: "bad tool schema" } }];
  const r = await chat({ model: "hard" });
  assert.equal(r.status, 400);
  assert.match(r.json.error.message, /bad tool schema/);
});

test("paid calls stop at the daily call limit; simple keeps working", async () => {
  fake.openrouter = () => reply("paid/cheap", "ok", { cost: 0 });
  // app_one already made 1 ok paid call (the failed ones don't count); the limit is 3
  assert.equal((await chat({ model: "medium" })).status, 200);
  assert.equal((await chat({ model: "hard" })).status, 200);
  const blocked = await chat({ model: "medium" });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.json.error.code, "daily_paid_calls_exceeded");
  assert.equal(blocked.json.localinfra.usage.today.paid_calls, 3);
  const calls = fake.seen.length;
  fake.openrouter = () => reply("free/a:free", "free", { cost: 0 });
  assert.equal((await chat({ model: "simple" })).status, 200);
  assert.equal(fake.seen.length, calls + 1, "the blocked call never reached OpenRouter");
  // limits are per app
  assert.equal((await chat({ model: "medium" }, otherKey)).status, 200);
});

test("paid calls stop at the monthly budget; no usage.cost = estimated from prices", async () => {
  gw.store.setLimits("app_two", { dailyPaidCalls: 100 });
  await gw.refreshPricing();
  // 3000 in * $0.000001 + 2000 out * $0.000002 = $0.007 per call, budget $0.01
  fake.openrouter = () => reply("paid/cheap", "ok", { prompt_tokens: 3000, completion_tokens: 2000 });
  assert.equal((await chat({ model: "medium" }, otherKey)).status, 200);
  assert.equal((await chat({ model: "medium" }, otherKey)).status, 200);
  const blocked = await chat({ model: "medium" }, otherKey);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.json.error.code, "monthly_budget_exceeded");

  const usage = await (await fetch(base + "/v1/usage", { headers: { Authorization: "Bearer " + otherKey } })).json();
  assert.equal(usage.app, "app_two");
  assert.ok(Math.abs(usage.month.spent_usd - 0.014) < 1e-9);
  assert.equal(usage.month.limit_usd, 0.01);

  gw.store.setLimits("app_two", { monthlyUsd: 1 });
  assert.equal((await chat({ model: "medium" }, otherKey)).status, 200);
});

test("models lists the tiers; a rotated key replaces the old one", async () => {
  const m = await (await fetch(base + "/v1/models", { headers: { Authorization: "Bearer " + key } })).json();
  assert.deepEqual(m.data.map((t) => [t.id, t.paid]), [["simple", false], ["medium", true], ["hard", true]]);
  assert.equal(m.data[0].fallback, "local/tiny:1b");

  const newKey = gw.store.rotate("app_one");
  assert.equal((await chat({ model: "simple" })).status, 401);
  assert.equal((await chat({ model: "simple" }, newKey)).status, 200);
  key = newKey;
});
