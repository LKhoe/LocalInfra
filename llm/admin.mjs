// llm-admin: manage the apps that may call the LLM gateway. Runs inside the container:
//   docker exec localinfra-llm llm-admin <command>
//
//   list                                       apps, limits and this month's spend
//   add <app>                                  new app; prints its key (only time it's shown)
//   rotate <app>                               new key for the app (adds it if missing)
//   has <app>                                  exit 0 when the app exists
//   limits <app> [--monthly-usd N|default] [--daily-calls N|default]
//                                              show or change the app's paid-call limits
//                                              (0 = no paid calls at all)
//   usage [<app>] [--days N]                   calls and spend per tier (default: this month)
//   remove <app>                               the key stops working; call history is kept
import { configFromEnv } from "./server.mjs";
import { openStore, monthStart } from "./store.mjs";

const config = configFromEnv();
const store = openStore(config.dbPath, config.defaults);
const [cmd, name, ...rest] = process.argv.slice(2);

const usd = (n) => "$" + n.toFixed(n >= 1 ? 2 : 4);
const die = (msg, code = 1) => {
  console.error(msg);
  process.exit(code);
};
const needApp = () => {
  if (!name || !/^[a-z][a-z0-9_]{1,30}$/.test(name)) die("App name must match ^[a-z][a-z0-9_]{1,30}$");
  return store.get(name);
};
function option(flag) {
  const i = rest.indexOf(flag);
  if (i < 0) return undefined;
  const v = rest[i + 1];
  if (v === "default") return null;
  if (v === undefined || !(Number(v) >= 0)) die(`${flag} needs a number >= 0, or "default"`);
  return Number(v);
}
function showLimits(app) {
  const u = store.usage(app);
  const l = store.limitsOf(app);
  console.log(
    `${app.name}: ${usd(u.month.spent_usd)} of ${usd(u.month.limit_usd)} this month, ` +
      `${u.today.paid_calls} of ${u.today.limit} paid calls today` + (l.custom ? "" : " (default limits)"),
  );
}

switch (cmd) {
  case "list": {
    const apps = store.list();
    if (!apps.length) console.log("No apps yet: scripts/new-project.sh <app> --llm");
    apps.forEach(showLimits);
    break;
  }
  case "add":
    if (needApp()) die(`App "${name}" already exists. Use rotate for a new key.`, 3);
    console.log(store.add(name));
    break;
  case "rotate":
    needApp();
    console.log(store.rotate(name));
    break;
  case "has":
    process.exit(needApp() ? 0 : 1);
  case "limits": {
    const app = needApp() || die(`No app "${name}"`);
    const monthlyUsd = option("--monthly-usd");
    const dailyPaidCalls = option("--daily-calls");
    if (monthlyUsd !== undefined || dailyPaidCalls !== undefined) store.setLimits(name, { monthlyUsd, dailyPaidCalls });
    showLimits(store.get(name));
    break;
  }
  case "usage": {
    let days;
    if (name === "--days") days = Number(rest[0]);
    else if (rest[0] === "--days") days = Number(rest[1]);
    const since = days ? Date.now() - days * 86400000 : monthStart(Date.now());
    const apps = name && name !== "--days" ? [needApp() || die(`No app "${name}"`)] : store.list();
    console.log(`Since ${new Date(since).toLocaleString()}`);
    for (const app of apps) {
      showLimits(app);
      for (const r of store.breakdown(app.name, since)) {
        console.log(
          `  ${r.tier.padEnd(6)} ${(r.provider || "failed").padEnd(10)} ${String(r.ok).padStart(5)} ok / ${String(r.calls).padStart(5)} calls  ` +
            `${String(r.prompt_tokens).padStart(9)} in ${String(r.completion_tokens).padStart(8)} out  ${usd(r.usd)}`,
        );
      }
    }
    break;
  }
  case "remove":
    needApp() || die(`No app "${name}"`);
    store.remove(name);
    console.log(`Removed "${name}": its key no longer works.`);
    break;
  default:
    die(
      "Usage: llm-admin list | add <app> | rotate <app> | has <app> | remove <app>\n" +
        "       llm-admin limits <app> [--monthly-usd N|default] [--daily-calls N|default]\n" +
        "       llm-admin usage [<app>] [--days N]",
    );
}
store.close();
