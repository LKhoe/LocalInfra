# LocalInfra

Shared data services for every project hosted on the Raspberry Pi (umbrelOS 2), plus a
small umbrelOS app that shows whether your containers are healthy.

| Service | Container | Network | Isolation per project |
|---|---|---|---|
| PostgreSQL 17 | `localinfra-postgres` | `localinfra_postgres` | own role + own database; other roles can't even connect |
| Redis 7.4 | `localinfra-redis` | `localinfra_redis` | own ACL user, limited to keys/channels `<project>:*` |
| Backup | `localinfra-backup` | `localinfra_postgres` | nightly dump of every database to the external drive |
| Container Health | `localinfra-health_server_1` | (umbrelOS app) | home-screen widgets, see [section 6](#6-container-health-widget-umbrelos) |

Projects don't run their own Postgres or Redis. They join the network(s) they need as
**external** networks and use the credentials made by `scripts/new-project.sh`.

```
LocalInfra/
  compose.yml                   postgres + redis + backup
  .env.example                  copy to .env (secrets, backup path, schedule)
  redis/                        tiny image: redis + ACL bootstrap (start.sh)
  backup/                       tiny image: pg_dump + busybox crond (backup.sh)
  scripts/bootstrap-pi.sh       first deploy from the Mac: LocalInfra + yarg, with checks
  scripts/new-project.sh        provision a project (db role + redis user), print its env
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

```bash
ssh-copy-id umbrel@umbrel.local                  # key login; docker over ssh can't ask for a password
ssh umbrel@umbrel.local docker ps                # must work WITHOUT sudo
ssh umbrel@umbrel.local uname -m                 # must print aarch64 (64-bit OS)
docker context create umbrel --docker "host=ssh://umbrel@umbrel.local"
```

Optional, but it makes every docker-over-ssh call much faster. In `~/.ssh/config`:

```
Host umbrel.local
  User umbrel
  ControlMaster auto
  ControlPath ~/.ssh/cm-%r@%h:%p
  ControlPersist 10m
```

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

### .env

```bash
cp .env.example .env
openssl rand -hex 32     # run twice: POSTGRES_SUPERUSER_PASSWORD and REDIS_ADMIN_PASSWORD
# set BACKUP_DIR=<mountpoint>/localinfra-backups   (a path ON THE PI)
```

With a Docker context, compose reads `.env` **on the Mac**, so this file is the only
place these secrets live. It is git-ignored; keep a copy in your password manager.

## 2. First deploy

`scripts/bootstrap-pi.sh` brings everything up from the Mac and checks each step. It is
safe to re-run.

1. Preflight: SSH key login, 64-bit Pi, docker without sudo, the `umbrel` context
   (created if missing), the `umbrel_main_network` network.
2. Backup folder + marker on the external drive.
3. Starts LocalInfra and waits for Postgres and Redis to be healthy.
4. Provisions `yarg` (database, role, Redis user) and writes the credentials into
   `../music/yarg-aggregator/.env` (the old file is kept as `.env.before-localinfra`).
5. Builds and starts yarg-aggregator on the Pi, waits for it to be healthy.
6. Runs a first backup.

It expects yarg-aggregator next to this repo (`../music/yarg-aggregator`, or set
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

```bash
DOCKER_CONTEXT=umbrel scripts/new-project.sh myapp              # postgres + redis
DOCKER_CONTEXT=umbrel scripts/new-project.sh myapp --no-redis   # postgres only
DOCKER_CONTEXT=umbrel scripts/new-project.sh myapp --rotate     # new passwords, data untouched
```

The script prints the env block for the project (`DATABASE_URL`, `POSTGRES_HOST`,
`REDIS_HOST`, `REDIS_USERNAME`, `REDIS_PASSWORD`, `REDIS_KEY_PREFIX`). Put it in the
project's `.env` and join the networks in its compose:

```yaml
services:
  app:
    networks: [localinfra_postgres, localinfra_redis]
networks:
  localinfra_postgres: { external: true }
  localinfra_redis:    { external: true }
```

To publish the app through the umbrelOS Cloudflare Tunnel app, also join
`umbrel_main_network` (external) and point the tunnel's hostname at
`http://<container_name>:<port>`.

**Redis rule for apps:** every key and pub/sub channel must start with
`REDIS_KEY_PREFIX` (ioredis `keyPrefix` for normal clients; BullMQ `prefix: "<project>:bull"`
on a connection *without* `keyPrefix`; channel names prefixed by hand). Anything else
gets `NOPERM`.

Removing a project (irreversible):

```bash
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
widgets:

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
umbrelOS) and only ever calls `GET /containers/json`.

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
BACKUP_DIR=./backups-local DOCKER_CONTEXT=desktop-linux docker compose up -d --build
DOCKER_CONTEXT=desktop-linux scripts/new-project.sh yarg
```

Postgres and Redis then listen on `127.0.0.1:5432` and `127.0.0.1:6379`. The printed
env uses the container names as hosts (`localinfra-postgres`, `localinfra-redis`); an
app running directly on the Mac (`npm run dev`) uses `localhost` instead.

To reach the **Pi's** databases from the Mac (TablePlus, Drizzle Studio, ...):

```bash
ssh -N -L 15432:127.0.0.1:5432 -L 16379:127.0.0.1:6379 umbrel@umbrel.local
```

## Notes

- **Upgrading Postgres to a new major version** (e.g. 17 → 18): take a backup, stop
  the stack, remove the `localinfra_postgres_data` volume, change `PG_VERSION`, start
  it, then restore `globals.sql` and each `.dump`. Minor updates only need
  `DOCKER_CONTEXT=umbrel docker compose pull && DOCKER_CONTEXT=umbrel docker compose up -d`.
- **What's isolated, and what isn't:** credentials and permissions separate the
  projects. Projects on the same network can still reach each other's containers, so
  don't run admin UIs without auth on these networks.
- **Ports:** Postgres and Redis are published on the Pi's loopback only
  (`POSTGRES_PUBLISH` / `REDIS_PUBLISH`); use the SSH tunnel above to reach them.
