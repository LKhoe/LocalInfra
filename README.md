# LocalInfra

Shared data services for every project hosted on the Raspberry Pi (umbrelOS 2), plus a
small umbrelOS app that shows whether your containers are healthy.

| Service | Container | Network | Isolation per project |
|---|---|---|---|
| PostgreSQL 17 | `localinfra-postgres` | `localinfra_postgres` | own role + own database; other roles can't even connect |
| Redis 7.4 | `localinfra-redis` | `localinfra_redis` | own ACL user, limited to keys/channels `<project>:*` |
| S3 (Garage 2.4) | `localinfra-s3` | `localinfra_s3` | own bucket + own access key; can't see, create or delete other buckets |
| Backup | `localinfra-backup` | `localinfra_postgres` | nightly dump of every database to the external drive |
| Cloudflare tunnel | `localinfra-tunnel` | `localinfra_tunnel` | reaches only the apps that join `localinfra_tunnel` |
| Container Health | `localinfra-health_server_1` | (umbrelOS app) | home-screen widgets, see [section 6](#6-container-health-widget-umbrelos) |

Projects don't run their own Postgres, Redis or file storage. They join the network(s) they need as
**external** networks and use the credentials made by `scripts/new-project.sh`.

```
LocalInfra/
  compose.yml                   postgres + redis + s3 + backup + tunnel
  .env.example                  copy to .env (secrets, backup path, schedule)
  redis/                        tiny image: redis + ACL bootstrap (start.sh)
  s3/                           tiny image: Garage binary on Alpine + marker check (start.sh)
  backup/                       tiny image: pg_dump + busybox crond (backup.sh)
  scripts/bootstrap-pi.sh       first deploy from the Mac: LocalInfra + yarg, with checks
  scripts/new-project.sh        provision a project (db role + redis user + S3 key), print its env
  scripts/provision-app.sh      new-project.sh + write the credentials into the app's .env
  templates/app/                compose, deploy.sh, Dockerfile, health route to copy into an app
  DEPLOYING-APPS.md             the standard way to deploy an app on the Pi (start here)
  scripts/check-health-app.sh   checks the Container Health app before a release
  umbrel-app-store.yml          makes this repo an umbrelOS community app store
  localinfra-health/            the "Container Health" umbrelOS app
```

Everything is deployed **from the Mac** through a Docker context named `umbrel`, so
the build runs on the Pi and nothing has to be copied there by hand. That's also why
there are no `./file` bind mounts: a relative path would point at a folder that only
exists on the Mac.

> **Always say which Docker you mean.** If `umbrel` is your active context
> (`docker context show`), a plain `docker compose ...` already runs on the Pi. The
> commands below set `DOCKER_CONTEXT=umbrel` (the Pi) or `DOCKER_CONTEXT=desktop-linux`
> (Docker Desktop on the Mac) explicitly.

---

## 1. One-time setup

### SSH and Docker context (on the Mac)

Docker talks to the Pi through its own SSH host alias, `umbrel-docker`, that **never shares a
connection** (`ControlMaster no`). With a shared connection (`ControlMaster auto`), a stale
master made docker commands hang with no timeout, once in the middle of a deploy, with the old
container stopped and the new one not started. Keep connection sharing, if you like it, on the
`umbrel.local` alias you use interactively. In `~/.ssh/config`:

```
# Interactive use (ssh umbrel.local): sharing a connection is fine here
Host umbrel.local
  User umbrel
  IdentityFile ~/.ssh/id_ed25519_umbrel
  IdentitiesOnly yes

# Docker over SSH (docker context "umbrel"): a fresh connection for every docker command
Host umbrel-docker
  HostName umbrel.local
  User umbrel
  IdentityFile ~/.ssh/id_ed25519_umbrel
  IdentitiesOnly yes
  ControlMaster no
  ControlPath none
  ServerAliveInterval 15
  ServerAliveCountMax 4
```

`ServerAlive*` makes a docker command fail after about a minute when the Pi stops answering,
instead of hanging. Then:

```bash
ssh-copy-id -i ~/.ssh/id_ed25519_umbrel umbrel@umbrel.local   # key login; docker over ssh can't ask for a password
ssh umbrel-docker docker ps                      # must work WITHOUT sudo
ssh umbrel-docker uname -m                       # must print aarch64 (64-bit OS)
docker context create umbrel --docker "host=ssh://umbrel-docker"
```

Already have the context from before? `docker context update umbrel --docker "host=ssh://umbrel-docker"`.
`deploy.sh` warns when the context's SSH host shares connections.

### External drive for backups

Find the drive's mount point on the Pi (umbrelOS mounts drives under
`/home/umbrel/umbrel/external/<label>`):

```bash
ssh umbrel@umbrel.local 'lsblk -o NAME,SIZE,FSTYPE,LABEL,MOUNTPOINTS'
```

The backup folder must contain a **marker file**. If the drive isn't mounted, Docker
silently creates an empty folder at that path on the SD card instead; the backup
refuses to run without the marker, so it never fills the SD card by accident.
`scripts/bootstrap-pi.sh` creates the folder and the marker for you (and checks that
the path is not on the SD card). To do it by hand:

```bash
ssh umbrel@umbrel.local 'mkdir -p "<mountpoint>/localinfra-backups" && touch "<mountpoint>/localinfra-backups/.localinfra-backup-target"'
```

### External drive for S3

Garage keeps its metadata and objects in `S3_DATA_DIR` on the same RAID 1 drive, guarded by
the same kind of marker file: without `.localinfra-s3-target` the container refuses to start
instead of filling the SD card. `scripts/bootstrap-pi.sh` creates it; by hand:

```bash
ssh umbrel@umbrel.local 'mkdir -p "<mountpoint>/localinfra-s3" && touch "<mountpoint>/localinfra-s3/.localinfra-s3-target"'
```

The drive is **exFAT**, so Garage uses its SQLite metadata engine (LMDB, the default, needs
sparse files). The objects are not backed up separately: they're on the RAID 1 drive, which
covers a dead disk but not deletions or the Pi being lost.

### .env

```bash
cp .env.example .env
openssl rand -hex 32     # one each: POSTGRES_SUPERUSER_PASSWORD, REDIS_ADMIN_PASSWORD, S3_RPC_SECRET, S3_ADMIN_TOKEN
# set CLOUDFLARE_TUNNEL_TOKEN=<token from Zero Trust → Networks → Tunnels → the tunnel>
# set BACKUP_DIR=<mountpoint>/localinfra-backups   (a path ON THE PI)
# set S3_DATA_DIR=<mountpoint>/localinfra-s3        (a path ON THE PI)
```

With a Docker context, compose reads `.env` **on the Mac**, so this file is the only
place these secrets live. It is git-ignored; keep a copy in your password manager.

## 2. First deploy

`scripts/bootstrap-pi.sh` brings everything up from the Mac and checks each step. It is
safe to re-run.

1. Preflight: SSH key login, 64-bit Pi, docker without sudo, the `umbrel` context
   (created if missing).
2. Backup and S3 folders + markers on the external drive.
3. Starts LocalInfra and waits for Postgres, Redis and S3 to be healthy.
4. Provisions `yarg` (database, role, Redis user) and writes the credentials into
   `../yarg-aggregator/.env` (the old file is kept as `.env.before-localinfra`).
5. Builds and starts yarg-aggregator on the Pi, waits for it to be healthy.
6. Runs a first backup.

It expects yarg-aggregator next to this repo (`../yarg-aggregator`, or set
`YARG_DIR=...`) with a `.env` already filled in (`BETTER_AUTH_SECRET`, URLs, OAuth keys;
see that repo's `.env.example`).

```bash
scripts/bootstrap-pi.sh
```

Overrides: `PI_SSH` (default `umbrel@umbrel.local`), `DOCKER_CONTEXT_NAME` (default
`umbrel`), `YARG_DIR`.

## 3. Day-to-day

```bash
DOCKER_CONTEXT=umbrel docker compose up -d --build     # apply changes (builds the two tiny images on the Pi)
DOCKER_CONTEXT=umbrel docker compose ps
DOCKER_CONTEXT=umbrel docker compose logs -f redis
```

Only containers whose definition changed are recreated; projects using LocalInfra keep
running.

## 4. Add a project

> **Deploying an app?** Follow [DEPLOYING-APPS.md](DEPLOYING-APPS.md): the app contract,
> templates, and the step-by-step for every new app. `scripts/provision-app.sh` runs the
> command below and writes its output into the app's `.env` for you.

```bash
DOCKER_CONTEXT=umbrel scripts/new-project.sh myapp              # postgres + redis
DOCKER_CONTEXT=umbrel scripts/new-project.sh myapp --no-redis   # postgres only
DOCKER_CONTEXT=umbrel scripts/new-project.sh myapp --s3         # postgres + redis + S3 bucket/key
DOCKER_CONTEXT=umbrel scripts/new-project.sh myapp --rotate     # new passwords, data untouched
```

The script prints the env block for the project (`DATABASE_URL`, `POSTGRES_HOST`,
`REDIS_HOST`, `REDIS_USERNAME`, `REDIS_PASSWORD`, `REDIS_KEY_PREFIX`, and with `--s3`:
`S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`). Put it in the
project's `.env` and join the networks in its compose:

```yaml
services:
  app:
    networks: [localinfra_postgres, localinfra_redis]   # + localinfra_s3 with --s3
networks:
  localinfra_postgres: { external: true }
  localinfra_redis:    { external: true }
```

**S3 rule for apps:** use path-style requests (`forcePathStyle: true` in the AWS SDK) against
`S3_ENDPOINT`, region `garage`. Bucket names use `-` where the project name has `_`
(`my_recipes` → bucket `my-recipes`). The key can read and write objects in its bucket and
nothing else; buckets are created only by `new-project.sh`. The S3 API is never published
through the tunnel: apps serve their files themselves (behind their own login).

To publish the app through LocalInfra's Cloudflare tunnel, also join
`localinfra_tunnel` (external) and point the tunnel's hostname at
`http://<container_name>:<port>`. The routes live in Cloudflare Zero Trust (Networks →
Tunnels), not in this repo; `localinfra-tunnel` only needs `CLOUDFLARE_TUNNEL_TOKEN` in `.env`.

**Redis rule for apps:** every key and pub/sub channel must start with
`REDIS_KEY_PREFIX` (ioredis `keyPrefix` for normal clients; BullMQ `prefix: "<project>:bull"`
on a connection *without* `keyPrefix`; channel names prefixed by hand). Anything else
gets `NOPERM`.

Removing a project (irreversible):

```bash
DOCKER_CONTEXT=umbrel docker exec localinfra-s3 garage key delete --yes <key id>        # garage key list
DOCKER_CONTEXT=umbrel docker exec localinfra-s3 garage bucket delete --yes myapp         # must be empty
DOCKER_CONTEXT=umbrel docker exec localinfra-postgres psql -U postgres -c 'DROP DATABASE myapp' -c 'DROP ROLE myapp'
DOCKER_CONTEXT=umbrel docker exec -e REDISCLI_AUTH="$(sed -n 's/^REDIS_ADMIN_PASSWORD=//p' .env)" localinfra-redis \
  sh -c 'redis-cli --no-auth-warning ACL DELUSER myapp && redis-cli --no-auth-warning ACL SAVE'
```

### Moving an existing database in

```bash
# 1. dump the old database to the Mac (example: a Postgres running on Docker Desktop)
DOCKER_CONTEXT=desktop-linux docker exec <old-container> pg_dump -U <user> -Fc <db> > old.dump
# 2. restore it as the project's role (it becomes owner of everything)
DOCKER_CONTEXT=umbrel docker exec -i localinfra-postgres pg_restore -U myapp -d myapp --no-owner --no-acl < old.dump
```

## 5. Backups

Every night at `BACKUP_CRON` (local time, `TZ`), the backup writes:

```
<BACKUP_DIR>/postgres/
  daily/2026-10-14_0400/   globals.sql (roles) + <db>.dump per database   kept BACKUP_KEEP_DAYS
  monthly/...              copy of the backup from the 1st of each month  kept BACKUP_KEEP_MONTHS
  last_success             timestamp of the last good run
```

`localinfra-backup` turns **unhealthy** when no backup succeeded in the last 26 hours,
so a missed backup shows up in `docker ps` and in the Container Health widget.

```bash
DOCKER_CONTEXT=umbrel docker exec localinfra-backup backup.sh                 # run now
DOCKER_CONTEXT=umbrel docker logs localinfra-backup                           # history
DOCKER_CONTEXT=umbrel docker exec localinfra-backup ls /backups/postgres/daily
# restore one database from a backup (replaces its contents)
DOCKER_CONTEXT=umbrel docker exec localinfra-backup \
  pg_restore --clean --if-exists -d myapp /backups/postgres/daily/<stamp>/myapp.dump
```

A copy on a drive plugged into the same Pi protects against mistakes and SD death, but
not against theft, fire or a power surge. Add an off-site copy if the data matters.

## 6. Container Health widget (umbrelOS)

This repo is also an umbrelOS community app store with one app, **Container Health**:
a status page (the app's *Open* button, behind the Umbrel login) and three home-screen
widgets.

The status page refreshes every 15 seconds (only while it's visible) and shows:

- **Resource map**: which containers use which LocalInfra resource (Postgres, Redis, S3, the
  Cloudflare tunnel), read from the networks each container joins. Hover a node to highlight its
  links. An app's public address shows under its name when it has the label
  `localinfra.url=https://...` (the app template sets it from `NEXT_PUBLIC_APP_URL`).
- **Projects**: every container with its status, resources and memory (used / limit), LocalInfra
  included.
- **Guides**: adding a Cloudflare tunnel route and a Google OAuth client, with the values for the
  chosen app and your domain filled in.

The widgets:

- **Summary**: same style as the native Live Usage widget, with icons: containers
  healthy, projects healthy, issues
- **Gauges**: two rings that fill with the healthy share of containers and projects
- **Projects**: one row per Compose project, problems first

It shows the containers **you** run, meaning anything umbrelOS didn't start (umbrelOS
apps carry the compose working dir `/opt/umbreld/...`). New projects show up on their
own. Hide a one-off container with the label `localinfra.health.hide=true`.

It is one container: the stock `node:24-alpine` image running
`localinfra-health/server.mjs.template`, non-root, read-only filesystem, no
capabilities. It reads the Docker socket through the host's `docker` group (gid 987 on
umbrelOS) and only calls `GET /containers/json` and, while the status page is open,
`GET /containers/<id>/stats` (one-shot, cached 10 seconds) for the memory readings.

### Install (once, in the Umbrel UI)

1. App Store → `⋯` (top right) → **Community App Stores** → add `https://github.com/LKhoe/LocalInfra`
2. Open the **LocalInfra** store → **Container Health** → **Install**
3. Home screen → right-click (or long-press) → **Edit widgets** → pick the
   Container Health widgets you want. umbrelOS allows 3 widgets in total.

### Release a new version

```bash
scripts/check-health-app.sh        # no "$" in the template, renders unchanged, valid JS
# bump "version" in localinfra-health/umbrel-app.yml, commit, push
```

umbrelOS checks community stores every 5 minutes; then open the app in the App Store
and click **Update**. If a widget changed its format, reload the Umbrel page once: the
dashboard keeps the last widget data in memory.

Why the server is a `.template`: umbrelOS app updates only copy `docker-compose.yml`,
`*.template`, `exports.sh`, `torrc`, `hooks` and `umbrel-app.yml`. Templates are rendered
with `envsubst` on install and update, so `server.mjs.template` must not contain a
dollar sign (no template literals); the check script enforces this. Any other file in
the app folder is only copied on a fresh install.

## 7. Local development on the Mac

Run the same stack on Docker Desktop. The shell variable overrides `BACKUP_DIR` from
`.env`, so the Pi settings stay untouched:

```bash
mkdir -p backups-local && touch backups-local/.localinfra-backup-target    # git-ignored
mkdir -p s3-local && touch s3-local/.localinfra-s3-target                  # git-ignored
BACKUP_DIR=./backups-local S3_DATA_DIR=./s3-local DOCKER_CONTEXT=desktop-linux docker compose up -d --build
DOCKER_CONTEXT=desktop-linux scripts/new-project.sh yarg
```

Postgres, Redis and S3 then listen on `127.0.0.1:5432`, `127.0.0.1:6379` and
`127.0.0.1:3900`. The printed
env uses the container names as hosts (`localinfra-postgres`, `localinfra-redis`); an
app running directly on the Mac (`npm run dev`) uses `localhost` instead.

To reach the **Pi's** databases from the Mac (TablePlus, Drizzle Studio, ...):

```bash
ssh -N -L 15432:127.0.0.1:5432 -L 16379:127.0.0.1:6379 -L 13900:127.0.0.1:3900 umbrel@umbrel.local
```

## Notes

- **Upgrading Postgres to a new major version** (e.g. 17 → 18): take a backup, stop
  the stack, remove the `localinfra_postgres_data` volume, change `PG_VERSION`, start
  it, then restore `globals.sql` and each `.dump`. Minor updates only need
  `DOCKER_CONTEXT=umbrel docker compose pull && DOCKER_CONTEXT=umbrel docker compose up -d`.
- **What's isolated, and what isn't:** credentials and permissions separate the
  projects. Projects on the same network can still reach each other's containers, so
  don't run admin UIs without auth on these networks.
- **Ports:** Postgres, Redis and the S3 API are published on the Pi's loopback only
  (`POSTGRES_PUBLISH` / `REDIS_PUBLISH` / `S3_PUBLISH`); use the SSH tunnel above to reach
  them. Garage's RPC and admin ports are never published.
- **Upgrading Garage:** bump `GARAGE_VERSION`, then `DOCKER_CONTEXT=umbrel docker compose up -d --build s3`.
  Read the release notes first for major versions.
