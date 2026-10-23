#!/usr/bin/env bash
# Deploy LocalInfra to the Raspberry Pi from the Mac, through the Docker context: the small images
# are built on the Pi and only the services whose definition changed are recreated, so the apps
# using LocalInfra keep running. The first deploy is scripts/bootstrap-pi.sh.
#
#   ./deploy.sh                  apply compose.yml on the Pi, wait until every service is healthy
#   ./deploy.sh llm s3           only these services
#   ./deploy.sh --health         release the Container Health app: checks, version bump check, git push
#                                (umbrelOS picks the new version up from GitHub, not from this script)
#
# Overridable: DEPLOY_CONTEXT (default "umbrel")
set -euo pipefail

cd "$(dirname "$0")"

export DOCKER_CONTEXT="${DEPLOY_CONTEXT:-umbrel}"
COMPOSE=(docker compose -f compose.yml)
HEALTH_DIR=localinfra-health

die() { echo "❌ $*" >&2; exit 1; }
confirm() {
  printf '%s [y/N] ' "$1" >&2
  local answer=""
  read -r answer || true
  [[ -t 0 ]] || echo >&2
  [[ "$answer" =~ ^[Yy]$ ]] || die "Not deployed.$([[ -t 0 ]] || echo ' (no terminal to answer: pipe "y" in to confirm)')"
}
# "version" of an umbrel-app.yml read from git (rev:path)
app_version() { git show "$1" 2>/dev/null | sed -n 's/^version: *"\{0,1\}\([^"]*\)"\{0,1\} *$/\1/p'; }

# ---------------------------------------------------------------- Container Health release
if [[ "${1:-}" == "--health" ]]; then
  [[ "$(git branch --show-current)" == main ]] || die "Release from main (umbrelOS reads the default branch)."
  [[ -z "$(git status --porcelain -- "$HEALTH_DIR")" ]] \
    || die "$HEALTH_DIR/ has uncommitted changes: commit them first (only commits are released)."
  scripts/check-health-app.sh

  echo "==> Comparing with GitHub..."
  git fetch -q origin main
  [[ -n "$(git log --oneline origin/main..HEAD)" ]] || { echo "Nothing to push: origin/main is up to date."; exit 0; }
  git merge-base --is-ancestor origin/main HEAD || die "origin/main has commits that main doesn't: pull first."

  live=$(app_version "origin/main:$HEALTH_DIR/umbrel-app.yml")
  next=$(app_version "HEAD:$HEALTH_DIR/umbrel-app.yml")
  if [[ -n "$(git diff --name-only origin/main HEAD -- "$HEALTH_DIR")" && "$live" == "$next" ]]; then
    die "$HEALTH_DIR/ changed but its version is still $next: bump 'version' in $HEALTH_DIR/umbrel-app.yml (else Umbrel offers no update)."
  fi

  echo "Container Health: ${live:-new} -> $next. Commits to push:"
  git log --oneline origin/main..HEAD | sed 's/^/  /'
  confirm "Push main to origin?"
  git push origin main
  echo "==> Pushed. umbrelOS checks community stores every 5 minutes: then App Store → Container Health → Update."
  exit 0
fi
[[ "${1:-}" != -* ]] || die "Unknown option: $1 (use --health, or service names)"

# ---------------------------------------------------------------- pre-flight
[[ -f .env ]] || die ".env not found (copy .env.example). compose reads it on this machine."

# Docker over a *shared* SSH connection (ControlMaster) hangs with no timeout when that connection
# goes stale. README section 1 has the 'umbrel-docker' alias.
docker_host=$(docker context inspect "$DOCKER_CONTEXT" --format '{{.Endpoints.docker.Host}}' 2>/dev/null || true)
if [[ "$docker_host" == ssh://* ]]; then
  if [[ "$(ssh -G "${docker_host#ssh://}" 2>/dev/null | awk '$1 == "controlmaster" { print $2 }')" != false ]]; then
    echo "Warning: Docker context '${DOCKER_CONTEXT}' (${docker_host}) shares SSH connections (ControlMaster)," >&2
    echo "         which can hang a deploy halfway. Use the 'umbrel-docker' alias: README section 1." >&2
    confirm "Deploy anyway?"
  fi
fi
docker info --format '{{.Name}}' >/dev/null 2>&1 \
  || die "Docker context '${DOCKER_CONTEXT}' is not reachable (docker context inspect ${DOCKER_CONTEXT})."

config=$("${COMPOSE[@]}" config --format json) || die "compose.yml / .env don't resolve (see the error above)."

services=("$@")
if (( ${#services[@]} == 0 )); then
  while read -r s; do services+=("$s"); done < <(jq -r '.services | keys[]' <<<"$config")
fi
for s in "${services[@]}"; do
  jq -e --arg s "$s" '.services | has($s)' <<<"$config" >/dev/null \
    || die "No service '$s' in compose.yml ($(jq -r '.services | keys | join(", ")' <<<"$config"))."
done

# Bind mounts are paths on the Pi. A Mac path means a relative path or a local-dev override
# (BACKUP_DIR=./backups-local exported in this shell wins over .env).
mac_paths=$(jq -r '.services[].volumes[]? | select(.type == "bind") | .source | select(startswith("/Users/") or startswith("/private/"))' <<<"$config")
[[ -z "$mac_paths" ]] || die "Bind mounts point at this Mac, not the Pi (check BACKUP_DIR / S3_DATA_DIR in .env and in your shell):
$mac_paths"

if [[ "$(git branch --show-current 2>/dev/null)" != main ]]; then
  echo "Warning: You are on branch '$(git branch --show-current)', not 'main'." >&2
  confirm "Continue anyway?"
fi
# The build context is this folder: uncommitted files go into the images. The Container Health app
# is not deployed by compose (it's an umbrelOS app), so its folder doesn't count.
dirty=$(git status --porcelain -- . ":!$HEALTH_DIR" ":!CLAUDE.md")
if [[ -n "$dirty" ]]; then
  echo "Warning: Working tree has uncommitted changes (they WILL be deployed):" >&2
  echo "$dirty" >&2
  confirm "Continue anyway?"
fi

# ---------------------------------------------------------------- build + restart
START_TIME=$(date +%s)
echo "==> Deploying ${services[*]} on '${DOCKER_CONTEXT}' (images build there)..."
"${COMPOSE[@]}" up -d --build "${services[@]}"

wait_healthy() { # container, max seconds
  local c=$1 max=$2 waited=0 status
  while :; do
    status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$c" 2>/dev/null || echo missing)
    [[ "$status" == healthy ]] && { echo "✅ $c is healthy"; return 0; }
    if (( waited >= max )) || [[ "$status" == unhealthy || "$status" == exited || "$status" == dead ]]; then
      echo "❌ $c did not become healthy (status: $status). Last logs:" >&2
      docker logs --tail 60 "$c" 2>&1 | sed 's/^/    /' >&2 || true
      return 1
    fi
    sleep 5; waited=$((waited + 5))
  done
}

echo "==> Waiting for the services to become healthy..."
failed=()
for s in "${services[@]}"; do
  c=$(jq -r --arg s "$s" '.services[$s].container_name // empty' <<<"$config")
  wait_healthy "${c:-$s}" 180 || failed+=("$s")
done
(( ${#failed[@]} == 0 )) || die "Not healthy: ${failed[*]}. Logs: DOCKER_CONTEXT=${DOCKER_CONTEXT} docker compose logs -f <service>"

ELAPSED=$(( $(date +%s) - START_TIME ))
echo "==> Done in $(( ELAPSED / 60 ))m $(( ELAPSED % 60 ))s."
