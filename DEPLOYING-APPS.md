# Deploying an app on the Pi

The one way every app is deployed on the Raspberry Pi (umbrelOS): from the Mac, through the
`umbrel` Docker context, on LocalInfra's shared services. Follow the same steps for every new
app. Reference implementation: **my-recipes**.

```
 Mac (repo + .env)                          Raspberry Pi
 ./deploy.sh ── docker context "umbrel" ──► build image, run container <app>
                                              ├─ localinfra_postgres → db + role <app_name>
                                              ├─ localinfra_redis    → ACL user, keys "<app_name>:*"
                                              ├─ localinfra_s3       → bucket <app-name> + key
                                              ├─ localinfra_llm      → LLM key, limits on paid calls
                                              ├─ localinfra_metrics  → metrics key (anonymous usage metrics)
                                              └─ localinfra_tunnel   → Cloudflare tunnel → https://<app>.<domain>
```

Nothing is cloned or copied to the Pi by hand. LocalInfra backs up every database nightly and
the Container Health widget shows the app as soon as it runs.

---

## The app contract

What every app needs before it can be deployed. The templates in
[`templates/app/`](templates/app) already follow it.

| | Rule | Why |
|---|---|---|
| 1 | `docker-compose.yml` has **one service**; `container_name`, service name and image name are the app name (kebab-case), image tag `:latest` | `deploy.sh` reads everything from compose and keeps `<app>:previous` for rollback |
| 2 | **No database, Redis or file volume of its own**: data goes to LocalInfra Postgres / Redis / S3. **No LLM API key of its own**: LLM calls go to LocalInfra's gateway | one place to run, back up, monitor and pay for |
| 3 | **No bind mounts** (`./file:/path`) | compose runs on the Mac, the paths would be looked up on the Pi |
| 4 | Joins LocalInfra's networks as **external** networks, plus `localinfra_tunnel` if public | the tunnel and the shared services are reachable by container name |
| 5 | A **healthcheck** on `GET /api/health` that checks the app's dependencies (DB, bucket, ...) | `deploy.sh` waits for it; the widget turns red when it fails |
| 6 | A **unique host port** from the table below, container port 3000 | LAN access; two apps can't share a port |
| 7 | A **memory limit** (512M default) and json-file log rotation | the Pi also runs umbrelOS and its apps |
| 8 | The container **migrates on start** (entrypoint: wait for Postgres → migrate → start) | no manual step after a deploy |
| 9 | Runtime deps come from the **lockfile** (`npm ci --omit=dev` in the runner stage), never `npm install <pkg>` | a bare install re-resolves every dependency; native modules (sharp) end up with mismatched versions |
| 10 | **`.env` = the Pi, `.env.local` = local dev**, both git-ignored together with `.env.bak-*` | compose reads `.env` on the Mac; Next.js and dev scripts let `.env.local` win |
| 11 | Redis keys/channels start with `REDIS_KEY_PREFIX`; S3 uses path-style requests, region `garage`; the bucket is never exposed, the app serves its files itself; LLM calls ask for a tier (`simple`/`medium`/`hard`) and handle `429` | LocalInfra's isolation rules (README section 4) |

### Port table

| Port | App |
|---|---|
| 3000 | yarg-aggregator |
| 3001 | my-recipes |
| 3002 | sports-cal |
| 3003 | brain-gym |
| 3004 | *next free* |

Add the app here when you pick its port.

---

## Steps for a new app

Prerequisites, once per Mac: SSH key login and the `umbrel` Docker context on the
`umbrel-docker` SSH alias, which never shares connections (README section 1), and LocalInfra
running on the Pi.

### 1. Prepare the repo (once)

Copy from `templates/app/` into the app repo and replace `myapp` / `30XX`:

| Template | Goes to | Change |
|---|---|---|
| `docker-compose.yml` | repo root | app name, port, drop unused LocalInfra blocks, add the app's env vars |
| `deploy.sh` | repo root | nothing (same file in every app) |
| `Dockerfile`, `docker-entrypoint.sh`, `scripts/migrate.mjs` | same paths | only for a Next.js + Drizzle app; otherwise write your own that keeps rules 8–9 |
| `app/api/health/route.ts` | same path | add the app's other dependencies |
| `lib/metrics/`, `components/metrics.tsx`, `app/api/metrics/route.ts` | same paths | optional, anonymous usage metrics: add `<Metrics />` to the root layout and `onRequestError` to `instrumentation.ts` |
| `.env.example` | repo root | the app's own settings |

`.gitignore` must contain:

```
.env
.env*.local
.env.bak-*
```

Add the app to the port table above.

### 2. Provision on LocalInfra and write `.env` (once)

```bash
DOCKER_CONTEXT=umbrel ../LocalInfra/scripts/provision-app.sh <app_name> <path/to/app> [--no-redis] [--s3] [--llm] [--metrics]
```

An app that already exists and only needs the LLM key:
`provision-app.sh <app_name> <path/to/app> --no-postgres --no-redis --llm` (then `./deploy.sh`), and the
same with `--metrics` for the metrics key (README section 4, "Metrics").

`<app_name>` uses `_`, not `-` (`my_recipes`): it names the database, the role and the keys.
The script creates them, writes the credentials into the app's `.env` (from `.env.example` if
missing; the old file is kept as `.env.bak-<time>`) and **lists every value still local or a
placeholder**. Fill those in: the public URL, `PORT`, secrets (`openssl rand -base64 32`),
OAuth/API keys. Local-dev values go to `.env.local`, not `.env`.

### 3. Public access (once, manual)

The Container Health page (Umbrel → Container Health → Open) has these as step-by-step guides,
with the values for the app filled in and a copy button on each.

- **Cloudflare Zero Trust → Networks → Tunnels** → the LocalInfra tunnel (`localinfra-tunnel`) → *Published application
  routes*: add the public hostname, service `HTTP`, URL `<app>:3000`.
- **OAuth providers** (Google, ...): add `https://<hostname>/api/auth/callback/<provider>` as a
  redirect URI.
- **Alexa skill** (optional): a custom skill whose HTTPS endpoint is the app itself, at the URI in
  its `skill.json` (`/api/alexa`; `/api/alexa/skill` in my-recipes), with the *wildcard
  certificate* option, then `ALEXA_SKILL_ID` in `.env`. Details in the app's README.

### 4. First deploy

```bash
./deploy.sh
```

It checks the target, the external networks and `.env` (warns about leftover local values and
uncommitted changes), builds on the Pi (3–5 minutes), restarts the container and waits until
it's healthy. Then the app's own first-run step, if any (first admin, invite code, seed).

Moving existing data in, **before** the first deploy so migrations don't create empty tables first:

```bash
DOCKER_CONTEXT=<old context> docker exec <old-postgres> pg_dump -U <user> -Fc <db> > app.dump
DOCKER_CONTEXT=umbrel docker exec -i localinfra-postgres pg_restore -U <app_name> -d <app_name> --no-owner --no-acl < app.dump
```

Files into S3: through an SSH tunnel to the Pi's S3 port (my-recipes'
`scripts/upload-photos-to-s3.mjs` is an example):

```bash
ssh -N -L 13900:127.0.0.1:3900 umbrel@umbrel.local    # S3_ENDPOINT=http://localhost:13900
```

### 5. Check

```bash
curl -s http://umbrel.local:<port>/api/health                  # {"status":"ok"}
DOCKER_CONTEXT=umbrel docker compose ps                        # (healthy)
DOCKER_CONTEXT=umbrel docker compose logs -f <app>
```

Then open the public URL, sign in, and exercise what the health check can't (an upload, an
email, a background job).

---

## Every deploy after that

```bash
./deploy.sh              # deploy the working tree
./deploy.sh --release    # bump the patch version, commit and push, then deploy
./deploy.sh --rollback   # back to the image that was live before the last deploy
```

Only the app's container is rebuilt; LocalInfra and the other apps keep running. Rollback
restores the code, not the database: a migration that already ran stays applied.

## Rotating credentials

```bash
DOCKER_CONTEXT=umbrel ../LocalInfra/scripts/provision-app.sh <app_name> <path/to/app> [same flags] --rotate
./deploy.sh
```

New passwords/keys, same data. The app is down between the two commands.

## Removing an app

```bash
DOCKER_CONTEXT=umbrel docker compose down          # in the app repo: container only
```

Then its data on LocalInfra (irreversible), README section 4, "Removing a project". Remove the
tunnel hostname and the port table row.

## Local development

Run LocalInfra on Docker Desktop (README section 7), then provision the app there and point
`.env.local` at `localhost`:

```bash
DOCKER_CONTEXT=desktop-linux scripts/new-project.sh <app_name> [--no-redis] [--s3]   # prints the values
```

Use them in `.env.local` with `localhost` instead of the container names
(`localinfra-postgres` → `localhost:5432`, `localinfra-s3:3900` → `localhost:3900`).
Never run `provision-app.sh` against Docker Desktop for an app whose `.env` holds the Pi config.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Network localinfra_… not found` | LocalInfra isn't running on that context, or the app joins a network it wasn't provisioned for |
| `Bind for 0.0.0.0:<port> failed` | port taken: pick the next free one from the table |
| `password authentication failed` / S3 `403` / Redis `NOPERM` | `.env` doesn't match LocalInfra: rotate (above) |
| `Error loading shared library libvips-cpp.so…` | rule 9: install runtime deps with `npm ci --omit=dev` |
| Sign-in redirects to the wrong host | the public URL in `.env` is wrong; `NEXT_PUBLIC_*` needs a rebuild |
| docker commands to the Pi hang | the `umbrel` context is sharing an SSH connection: point it at the `umbrel-docker` alias (README section 1). Unstick it now with `ssh -O exit umbrel.local` |
| A deploy stopped mid-way and the app is down | `DOCKER_CONTEXT=umbrel docker ps -a --filter name=<app>`: remove a leftover `<id>_<app>` container (`docker rm`), then `DOCKER_CONTEXT=umbrel docker compose up -d --no-build <app>` starts the new image. `./deploy.sh --rollback` goes back to the previous one instead |
