// The gateway's state: one row per app (key hash + limits) and one row per call.
// SQLite in the llm_data volume; the server and llm-admin open it at the same time (WAL).
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";

export const PAID_TIERS = ["medium", "hard"];

const hashKey = (key) => createHash("sha256").update(key).digest("hex");

// Month and day start in the container's TZ: "this month" is the household's month
function monthStart(now) {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}
function dayStart(now) {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function openStore(path, defaults) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA temp_store = MEMORY;
    CREATE TABLE IF NOT EXISTS apps (
      name TEXT PRIMARY KEY,
      key_hash TEXT NOT NULL UNIQUE,
      monthly_usd REAL,          -- NULL = LLM_DEFAULT_MONTHLY_USD
      daily_paid_calls INTEGER,  -- NULL = LLM_DEFAULT_DAILY_PAID_CALLS
      created_at INTEGER NOT NULL,
      rotated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS calls (
      id INTEGER PRIMARY KEY,
      app TEXT NOT NULL,
      at INTEGER NOT NULL,
      tier TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      paid INTEGER NOT NULL,
      ok INTEGER NOT NULL,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      cost REAL NOT NULL DEFAULT 0,
      ms INTEGER,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS calls_app_at ON calls (app, at);
  `);

  const q = {
    byHash: db.prepare("SELECT * FROM apps WHERE key_hash = ?"),
    byName: db.prepare("SELECT * FROM apps WHERE name = ?"),
    all: db.prepare("SELECT * FROM apps ORDER BY name"),
    insert: db.prepare("INSERT INTO apps (name, key_hash, created_at) VALUES (?, ?, ?)"),
    rotate: db.prepare("UPDATE apps SET key_hash = ?, rotated_at = ? WHERE name = ?"),
    limits: db.prepare("UPDATE apps SET monthly_usd = ?, daily_paid_calls = ? WHERE name = ?"),
    remove: db.prepare("DELETE FROM apps WHERE name = ?"),
    record: db.prepare(
      "INSERT INTO calls (app, at, tier, provider, model, paid, ok, prompt_tokens, completion_tokens, cost, ms, error)" +
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    spent: db.prepare("SELECT COALESCE(SUM(cost), 0) AS usd FROM calls WHERE app = ? AND at >= ?"),
    paidCalls: db.prepare("SELECT COUNT(*) AS n FROM calls WHERE app = ? AND at >= ? AND paid = 1 AND ok = 1"),
    byTier: db.prepare(
      "SELECT tier, provider, COUNT(*) AS calls, SUM(ok) AS ok, COALESCE(SUM(cost), 0) AS usd," +
        " COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens, COALESCE(SUM(completion_tokens), 0) AS completion_tokens" +
        " FROM calls WHERE app = ? AND at >= ? GROUP BY tier, provider ORDER BY tier, provider",
    ),
    prune: db.prepare("DELETE FROM calls WHERE at < ?"),
  };

  const newKey = () => "llm_" + randomBytes(24).toString("hex");

  const limitsOf = (app) => ({
    monthly_usd: app.monthly_usd ?? defaults.monthlyUsd,
    daily_paid_calls: app.daily_paid_calls ?? defaults.dailyPaidCalls,
    custom: app.monthly_usd != null || app.daily_paid_calls != null,
  });

  return {
    close: () => db.close(),

    findByKey: (key) => (key ? q.byHash.get(hashKey(key)) : undefined),
    get: (name) => q.byName.get(name),
    list: () => q.all.all(),

    // Returns the key: the only time it exists in clear text
    add(name) {
      const key = newKey();
      q.insert.run(name, hashKey(key), Date.now());
      return key;
    },
    rotate(name) {
      if (!q.byName.get(name)) return this.add(name);
      const key = newKey();
      q.rotate.run(hashKey(key), Date.now(), name);
      return key;
    },
    remove: (name) => q.remove.run(name).changes > 0,

    // undefined = keep, null = back to the default
    setLimits(name, { monthlyUsd, dailyPaidCalls }) {
      const app = q.byName.get(name);
      if (!app) return false;
      q.limits.run(
        monthlyUsd === undefined ? app.monthly_usd : monthlyUsd,
        dailyPaidCalls === undefined ? app.daily_paid_calls : dailyPaidCalls,
        name,
      );
      return true;
    },

    limitsOf,

    usage(app, now = Date.now()) {
      const limits = limitsOf(app);
      return {
        app: app.name,
        month: {
          since: new Date(monthStart(now)).toISOString(),
          spent_usd: q.spent.get(app.name, monthStart(now)).usd,
          limit_usd: limits.monthly_usd,
        },
        today: {
          since: new Date(dayStart(now)).toISOString(),
          paid_calls: q.paidCalls.get(app.name, dayStart(now)).n,
          limit: limits.daily_paid_calls,
        },
      };
    },

    breakdown: (name, since) => q.byTier.all(name, since),

    // Why a paid call can't go out now, or null when it can
    paidBlock(app, now = Date.now()) {
      const u = this.usage(app, now);
      if (u.month.spent_usd >= u.month.limit_usd) {
        return {
          code: "monthly_budget_exceeded",
          message: `Monthly budget for paid LLM calls used up: $${u.month.spent_usd.toFixed(4)} of $${u.month.limit_usd}. Use the "simple" tier, or raise the limit (llm-admin limits ${app.name} --monthly-usd N).`,
          usage: u,
        };
      }
      if (u.today.paid_calls >= u.today.limit) {
        return {
          code: "daily_paid_calls_exceeded",
          message: `Daily limit of paid LLM calls reached: ${u.today.paid_calls} of ${u.today.limit}. Use the "simple" tier, or raise the limit (llm-admin limits ${app.name} --daily-calls N).`,
          usage: u,
        };
      }
      return null;
    },

    record(c) {
      q.record.run(
        c.app, c.at ?? Date.now(), c.tier, c.provider ?? null, c.model ?? null,
        PAID_TIERS.includes(c.tier) ? 1 : 0, c.ok ? 1 : 0,
        c.promptTokens ?? null, c.completionTokens ?? null, c.cost ?? 0, c.ms ?? null, c.error ?? null,
      );
    },

    prune: (olderThanDays) => q.prune.run(Date.now() - olderThanDays * 86400000).changes,
  };
}

export { monthStart, dayStart };
