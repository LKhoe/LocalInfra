# LocalInfra

Shared data services for every project hosted on the Raspberry Pi (umbrelOS).

| Service | Container | Network | Isolation per project |
|---|---|---|---|
| PostgreSQL 17 | `localinfra-postgres` | `localinfra_postgres` | own role + own database; nobody else can connect to it |
| Redis 7.4 | `localinfra-redis` | `localinfra_redis` | own ACL user, limited to keys/channels `<project>:*` |
| Backup | `localinfra-backup` | `localinfra_postgres` | nightly dump of every database to the external drive |

Projects don't run their own Postgres or Redis. They join the network(s) they need as
**external** networks and use the credentials made by `scripts/new-project.sh`.

```
LocalInfra/
  compose.yml          postgres + redis + backup
  .env.example         copy to .env (secrets, backup path, schedule)
  redis/               tiny image: redis + ACL bootstrap (start.sh)
  backup/              tiny image: pg_dump + busybox crond (backup.sh)
  scripts/new-project.sh    provision a project (db role + redis user), print its env
  scripts/bootstrap-pi.sh   first deploy from the Mac: LocalInfra + yarg, with checks
  umbrel-app-store.yml      makes this repo an umbrelOS community app store
  localinfra-health/        "Container Health" umbrelOS app: home-screen widgets
```

There are no `./file` bind mounts on purpose. The stack can be deployed from the Mac
through a Docker context, and a relative bind mount would point at a path that only
exists on the Mac.

---

## 1. One-time setup

### SSH and Docker context (on the Mac)

```bash
ssh-copy-id umbrel@umbrel.local                 # key auth; docker over ssh can't prompt for a password
ssh umbrel@umbrel.local docker ps               # must work WITHOUT sudo
ssh umbrel@umbrel.local uname -m                # must print aarch64 (64-bit OS)
docker context create pi --docker "host=ssh://umbrel@umbrel.local"
```

Optional, but it makes every docker-over-ssh call much faster. Add this to `~/.ssh/config`:

```
Host umbrel.local
  User umbrel
  ControlMaster auto
  ControlPath ~/.ssh/cm-%r@%h:%p
  ControlPersist 10m
```

### External drive for backups (on the Pi)

```bash
ssh umbrel@umbrel.local 'lsblk -o NAME,SIZE,FSTYPE,LABEL,MOUNTPOINTS'
```

Pick the drive's mount point, then create the backup folder and the **marker file**:

```bash
ssh umbrel@umbrel.local 'mkdir -p "<mountpoint>/localinfra-backups" && touch "<mountpoint>/localinfra-backups/.localinfra-backup-target"'
```

If the drive isn't mounted, Docker silently creates an empty folder at that path on
the system disk instead. The backup refuses to run unless it finds the marker file, so
it never fills the SD card by accident. Prefer an ext4 drive.

### .env

```bash
cp .env.example .env
# fill POSTGRES_SUPERUSER_PASSWORD and REDIS_ADMIN_PASSWORD with: openssl rand -hex 32
# set BACKUP_DIR=<mountpoint>/localinfra-backups   (path ON THE PI)
```

With a Docker context, compose reads `.env` **on the Mac**, so this file is the only
place these secrets live. It is git-ignored; keep a copy in your password manager.

## 2. Start / update

First time (also provisions and deploys yarg-aggregator; safe to re-run):

```bash
scripts/bootstrap-pi.sh
```

Afterwards:

```bash
DOCKER_CONTEXT=pi docker compose up -d --build
DOCKER_CONTEXT=pi docker compose ps
```

The `--build` step only builds the two tiny images (a few seconds on the Pi).

## 3. Add a project

```bash
DOCKER_CONTEXT=pi scripts/new-project.sh myapp              # postgres + redis
DOCKER_CONTEXT=pi scripts/new-project.sh myapp --no-redis   # postgres only
DOCKER_CONTEXT=pi scripts/new-project.sh myapp --rotate     # new passwords, data untouched
```

The script prints the env block for the project (`DATABASE_URL`, `REDIS_USERNAME`,
`REDIS_PASSWORD`, `REDIS_KEY_PREFIX`, ...). In the project's compose:

```yaml
services:
  app:
    networks: [localinfra_postgres, localinfra_redis]
networks:
  localinfra_postgres: { external: true }
  localinfra_redis:    { external: true }
```

**Redis rule for apps:** every key and pub/sub channel must start with `REDIS_KEY_PREFIX`
(ioredis `keyPrefix` for normal clients; BullMQ `prefix: "<project>:bull"` on a
connection *without* `keyPrefix`; channel names prefixed by hand). Anything else gets
`NOPERM`.

Removing a project (irreversible):

```bash
DOCKER_CONTEXT=pi docker exec localinfra-postgres psql -U postgres -c 'DROP DATABASE myapp' -c 'DROP ROLE myapp'
DOCKER_CONTEXT=pi docker exec -e REDISCLI_AUTH=<admin pw> localinfra-redis sh -c 'redis-cli --no-auth-warning ACL DELUSER myapp && redis-cli --no-auth-warning ACL SAVE'
```

## 4. Backups

Every night at `BACKUP_CRON` (local time, `TZ`), the backup writes:

```
<BACKUP_DIR>/postgres/
  daily/2026-10-14_0400/   globals.sql (roles) + <db>.dump per database   kept BACKUP_KEEP_DAYS
  monthly/...              copy of the backup from the 1st of each month  kept BACKUP_KEEP_MONTHS
  last_success             timestamp of the last good run
```

```bash
DOCKER_CONTEXT=pi docker exec localinfra-backup backup.sh                 # run now
DOCKER_CONTEXT=pi docker logs localinfra-backup                           # history
DOCKER_CONTEXT=pi docker exec localinfra-backup ls /backups/postgres/daily
# restore one database from a backup (replaces its contents)
DOCKER_CONTEXT=pi docker exec localinfra-backup \
  pg_restore --clean --if-exists -d myapp /backups/postgres/daily/<stamp>/myapp.dump
```

A copy on a drive plugged into the same Pi protects against mistakes and SD/SSD death,
but not against theft, fire or a power surge. Add an off-site copy later if the data
matters.

## 5. Local development on the Mac

Use the same stack locally: in `.env` set `BACKUP_DIR=./backups-local`, create
`backups-local/.localinfra-backup-target`, then run `docker compose up -d --build`
**without** `DOCKER_CONTEXT`. Postgres and Redis listen on `127.0.0.1:5432/6379`.

To reach the Pi's databases from the Mac (TablePlus, drizzle studio, ...):

```bash
ssh -N -L 15432:127.0.0.1:5432 -L 16379:127.0.0.1:6379 umbrel@umbrel.local
```

## 6. Moving yarg-aggregator from its old built-in Postgres/Redis (one-off)

Run these from the Mac. The yarg compose change is in that repo.

```bash
export DOCKER_CONTEXT=pi
# 1. provision; keep the output for yarg's .env on the Pi
scripts/new-project.sh yarg
# 2. dump the old database (the file lands on the Mac)
docker exec yarg-postgres sh -c 'pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"' > yarg-old.dump
# 3. stop the old containers (volumes are kept until you delete them)
docker stop yarg-aggregator yarg-postgres yarg-redis
# 4. restore as the new "yarg" role (it becomes owner of everything)
docker exec -i localinfra-postgres pg_restore -U yarg -d yarg --no-owner --no-acl < yarg-old.dump
# 5. on the Pi: update yarg's .env with the block from step 1, then deploy yarg as usual
# 6. once everything works:
docker rm yarg-postgres yarg-redis
docker volume ls | grep yarg     # then: docker volume rm <the old postgres/redis volumes>
```

Old Redis data (queue history, progress) is temporary and isn't migrated.

## 7. Container Health widget (umbrelOS)

This repo is also an umbrelOS community app store with one app, **Container Health**:
a status page behind the Umbrel login and three home-screen widgets to pick from:

- **Summary**: same style as the native Live Usage widget (containers healthy,
  projects healthy, issues, with icons)
- **Gauges**: two rings that fill with the healthy share of containers and projects
- **Projects**: one row per Compose project, problems first

- It lists the containers **you** run: anything umbrelOS didn't start (umbrelOS apps
  carry the compose working dir `/opt/umbreld/...`). New projects show up on their own.
- Hide a one-off container with the label `localinfra.health.hide=true`.
- `localinfra-backup` turns unhealthy when no backup succeeded in 26h, so a missed
  backup shows up there too.
- One container (stock `node:24-alpine` + `localinfra-health/server.mjs`), no root,
  read-only. It only calls `GET /containers/json` on the Docker socket; it reads it
  through the host's `docker` group (gid 987 on umbrelOS).

Install once, in the Umbrel UI:

1. App Store → `⋯` (top right) → **Community App Stores** → add `https://github.com/LKhoe/LocalInfra`
2. Open the **LocalInfra** store → **Container Health** → Install
3. Home screen → right-click (or long-press) → **Edit widgets** → add *Container Health*
   (umbrelOS allows 3 widgets in total)

To update it: change `localinfra-health/`, bump `version` in its `umbrel-app.yml`,
push, then update the app in the Umbrel App Store.

## Notes

- **Upgrading Postgres to a new major version** (e.g. 17 → 18): take a backup, stop
  the stack, remove the `localinfra_postgres_data` volume, change `PG_VERSION`, start
  it, then restore `globals.sql` and each `.dump`. Minor updates only need `docker compose pull && up -d`.
- **What's isolated, and what isn't:** credentials and permissions separate the
  projects. Projects on the same network can still reach each other's containers, so
  don't run admin UIs without auth on these networks.
- **Health of the backup:** `last_success` older than ~1 day means something is
  wrong. Easy to watch later with Uptime Kuma or a small script.
