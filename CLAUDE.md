# CLAUDE.md

Guidance for Claude Code in this repository. Everything is documented in `README.md` (setup,
backups, LLM gateway, Container Health widget) and `DEPLOYING-APPS.md` (how any app is deployed).

## What this is

Shared services for every app on the Raspberry Pi (umbrelOS 2): Postgres 17, Redis 7.4, S3 (Garage),
LLM gateway (Ollama + `llm/server.mjs`), nightly backup, Cloudflare tunnel, plus the "Container
Health" umbrelOS app (`localinfra-health/`). Apps join its networks as external networks.

## Commands

```bash
./deploy.sh [service...]                              # apply changes on the Pi, wait for healthy
./deploy.sh --health                                  # release Container Health (checks, version bump, git push)
DOCKER_CONTEXT=umbrel docker compose ps
DOCKER_CONTEXT=umbrel docker compose logs -f <service>

# Docker Desktop on the Mac (local dev for the apps)
BACKUP_DIR=./backups-local S3_DATA_DIR=./s3-local DOCKER_CONTEXT=desktop-linux docker compose up -d --build

scripts/provision-app.sh <app_name> <path/to/app> [--no-redis] [--s3] [--llm]  # new app + writes its .env
scripts/new-project.sh <name>        # provision only, prints the env
scripts/bootstrap-pi.sh              # first deploy from the Mac
scripts/check-health-app.sh          # before releasing the Container Health app
```

## Rules to keep

- **Always pass `DOCKER_CONTEXT` explicitly.** A bare `docker compose` runs on whichever context is
  active (usually `umbrel`, i.e. the Pi).
- **No `./file` bind mounts** in `compose.yml`: it is deployed from the Mac, so relative paths would
  point at the Mac. Use volumes or absolute Pi paths (`BACKUP_DIR`, `S3_DATA_DIR`).
- **Marker files guard the external drive** (`.localinfra-backup-target`, `.localinfra-s3-target`).
  Containers refuse to start/run without them so the SD card never fills. Don't bypass them.
- **Isolation per project**: own Postgres role+DB, Redis ACL user limited to `<project>:*`, S3 bucket
  + key, LLM key with paid-call limits. Keep new services consistent with that.
- Docker over SSH uses the alias `umbrel-docker` with `ControlMaster no` (a shared connection once
  hung a deploy mid-way). Don't change it to share connections.
- Postgres, Redis, S3 API and LLM gateway publish on the Pi's loopback only; reach them by SSH tunnel.
- Add every new app to the port table in `DEPLOYING-APPS.md` (next free: 3004).
- `.env` holds real secrets (Postgres/Redis admin, OpenRouter key, tunnel token). Never print or commit it;
  `.env.example` is the template.
- Postgres major upgrades need backup → remove volume → restore (README "Notes"), not an in-place bump.
