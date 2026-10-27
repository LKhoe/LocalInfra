// metrics-admin: manage the apps that may send metrics. Runs inside the container:
//   docker exec localinfra-metrics metrics-admin <command>
//
//   list            apps with a key
//   rotate <app>    new key for the app (adds it if missing); prints it, the only time it's shown
//   has <app>       exit 0 when the app exists
//   remove <app>    the key stops working; the app's metrics stay until retention removes them
import { configFromEnv } from "./server.mjs";
import { openStore } from "./store.mjs";

const store = openStore(configFromEnv().databaseUrl, { max: 1 });
const [cmd, name] = process.argv.slice(2);
const die = (msg, code = 1) => {
  console.error(msg);
  return store.close().then(() => process.exit(code));
};
const validName = () => /^[a-z][a-z0-9_]{1,30}$/.test(name || "");

await store.migrate();
switch (cmd) {
  case "list": {
    const apps = await store.listApps();
    console.log(apps.length ? apps.join("\n") : "No apps yet: scripts/new-project.sh <app> --metrics");
    break;
  }
  case "rotate":
    if (!validName()) await die("App name must match ^[a-z][a-z0-9_]{1,30}$");
    console.log(await store.rotate(name));
    break;
  case "has":
    if (!validName()) await die("App name must match ^[a-z][a-z0-9_]{1,30}$");
    await die("", (await store.hasApp(name)) ? 0 : 1);
    break;
  case "remove":
    if (!validName() || !(await store.hasApp(name))) await die(`No app "${name}"`);
    await store.removeApp(name);
    console.log(`Removed "${name}": its key no longer works.`);
    break;
  default:
    await die("Usage: metrics-admin list | rotate <app> | has <app> | remove <app>");
}
await store.close();
