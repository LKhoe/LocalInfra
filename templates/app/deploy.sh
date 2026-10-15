#!/usr/bin/env bash
# Deploy this app to the Raspberry Pi through a Docker context: the image is built and run on
# the Pi, nothing is cloned there. LocalInfra (Postgres/Redis/S3) keeps running.
# Same file in every app — copied from LocalInfra/templates/app/deploy.sh; see
# LocalInfra/DEPLOYING-APPS.md. Everything app-specific is read from docker-compose.yml.
#
#   ./deploy.sh              build what's in the working tree on the Pi, restart, wait for healthy
#   ./deploy.sh --release    first bump the patch version, commit and PUSH (needs package.json)
#   ./deploy.sh --rollback   restart the image that was live before the last deploy
#
# Overridable: DEPLOY_CONTEXT (default "umbrel")
set -euo pipefail

cd "$(dirname "$0")"

export DOCKER_CONTEXT="${DEPLOY_CONTEXT:-umbrel}"
COMPOSE=(docker compose -f docker-compose.yml)

die() { echo "❌ $*" >&2; exit 1; }
confirm() {
  printf '%s [y/N] ' "$1" >&2
  local answer=""
  read -r answer || true
  [[ -t 0 ]] || echo >&2
  [[ "$answer" =~ ^[Yy]$ ]] || die "Not deployed.$([[ -t 0 ]] || echo ' (no terminal to answer: pipe "y" in to confirm)')"
}

# ---------------------------------------------------------------- read the app from compose
[[ -f .env ]] || die ".env not found (compose reads it on this machine). See DEPLOYING-APPS.md step 2."
config=$("${COMPOSE[@]}" config --format json) || die "docker-compose.yml / .env don't resolve (see the error above)."

SERVICE=$(jq -r '.services | keys | if length == 1 then .[0] else empty end' <<<"$config")
[[ -n "$SERVICE" ]] || die "docker-compose.yml must define exactly one service (the app)."
CONTAINER=$(jq -r --arg s "$SERVICE" '.services[$s].container_name // empty' <<<"$config")
IMAGE_REF=$(jq -r --arg s "$SERVICE" '.services[$s].image // empty' <<<"$config")
[[ "$CONTAINER" == "$SERVICE" ]] || die "container_name must equal the service name ($SERVICE)."
[[ "$IMAGE_REF" == "$SERVICE:latest" ]] || die "image must be \"$SERVICE:latest\" (it's how --rollback finds the previous build)."
IMAGE=$SERVICE

wait_healthy() {
  echo "==> Waiting for ${CONTAINER} to become healthy..."
  local retries=0 max_retries=60 status
  while :; do
    status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$CONTAINER" 2>/dev/null || echo missing)
    [[ "$status" == healthy ]] && { echo "✅ ${CONTAINER} is healthy"; return 0; }
    [[ "$status" == no-healthcheck ]] && die "${CONTAINER} has no healthcheck — add one (DEPLOYING-APPS.md, the app contract)."
    if (( retries >= max_retries )) || [[ "$status" == unhealthy ]]; then
      echo "❌ ${CONTAINER} did not become healthy (status: ${status}). Last logs:" >&2
      docker logs --tail 60 "$CONTAINER" 2>&1 | sed 's/^/    /' >&2 || true
      exit 1
    fi
    retries=$((retries + 1))
    sleep 5
  done
}

# Docker over a *shared* SSH connection (ControlMaster) hangs with no timeout when that connection
# goes stale — it once froze a deploy mid-swap, old container stopped, new one not started.
docker_host=$(docker context inspect "$DOCKER_CONTEXT" --format '{{.Endpoints.docker.Host}}' 2>/dev/null || true)
if [[ "$docker_host" == ssh://* ]]; then
  ssh_host=${docker_host#ssh://}
  if [[ "$(ssh -G "$ssh_host" 2>/dev/null | awk '$1 == "controlmaster" { print $2 }')" != false ]]; then
    echo "Warning: Docker context '${DOCKER_CONTEXT}' (${docker_host}) shares SSH connections (ControlMaster)," >&2
    echo "         which can hang a deploy halfway. Use the 'umbrel-docker' alias: LocalInfra README section 1." >&2
    confirm "Deploy anyway?"
  fi
fi

docker info --format '{{.Name}}' >/dev/null 2>&1 \
  || die "Docker context '${DOCKER_CONTEXT}' is not reachable (docker context inspect ${DOCKER_CONTEXT})."

# ---------------------------------------------------------------- rollback
if [[ "${1:-}" == "--rollback" ]]; then
  docker image inspect "${IMAGE}:previous" >/dev/null 2>&1 \
    || die "No ${IMAGE}:previous image on '${DOCKER_CONTEXT}' — nothing to roll back to."
  echo "==> Rolling back ${SERVICE} to ${IMAGE}:previous on '${DOCKER_CONTEXT}'..."
  docker tag "${IMAGE}:previous" "${IMAGE}:latest"
  "${COMPOSE[@]}" up -d --no-build --force-recreate "$SERVICE"
  wait_healthy
  exit 0
fi

release=false
case "${1:-}" in
  "") ;;
  --release) release=true ;;
  *) die "Unknown option: $1 (use --release or --rollback)" ;;
esac

# ---------------------------------------------------------------- pre-flight
# External networks (LocalInfra's, umbrel_main_network) must already exist on the target —
# checked before the build, which takes minutes on the Pi.
while read -r net; do
  [[ -z "$net" ]] && continue
  docker network inspect "$net" >/dev/null 2>&1 \
    || die "Network $net not found on '${DOCKER_CONTEXT}'. Start LocalInfra (or the umbrelOS app that creates it) first."
done < <(jq -r '.networks // {} | to_entries[] | select(.value.external == true) | .value.name // .key' <<<"$config")

# .env is the Pi's config; local-dev values belong in .env.local
local_values=$(grep -nE '^[A-Z0-9_]+=.*(localhost|127\.0\.0\.1)' .env | sed -E 's/^([0-9]+):([A-Z0-9_]+)=.*/  line \1: \2/' || true)
if [[ -n "$local_values" ]]; then
  echo "Warning: .env still has local values (they belong in .env.local):" >&2
  echo "$local_values" >&2
  confirm "Deploy anyway?"
fi

CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || echo "")
if [[ -n "$CURRENT_BRANCH" && "$CURRENT_BRANCH" != "main" ]]; then
  echo "Warning: You are on branch '${CURRENT_BRANCH}', not 'main'." >&2
  confirm "Continue anyway?"
fi
if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
  echo "Warning: Working tree has uncommitted changes (they WILL be built into the image):" >&2
  git status --short >&2
  confirm "Continue anyway?"
fi

START_TIME=$(date +%s)

if $release; then
  [[ -f package.json ]] || die "--release bumps package.json's version; there is no package.json here."
  echo "==> Bumping version, committing and pushing..."
  npm version patch --no-git-tag-version
  git add package.json package-lock.json 2>/dev/null || git add package.json
  git commit -m "chore: bump version for deploy"
  git push origin "${CURRENT_BRANCH}"
fi

# ---------------------------------------------------------------- build + restart
# Keep the image that is live right now, for --rollback
if docker image inspect "${IMAGE}:latest" >/dev/null 2>&1; then
  docker tag "${IMAGE}:latest" "${IMAGE}:previous"
fi

echo "==> Building ${SERVICE} on '${DOCKER_CONTEXT}' (the build runs there: several minutes on the Pi)..."
"${COMPOSE[@]}" build "$SERVICE"
"${COMPOSE[@]}" up -d "$SERVICE"
wait_healthy

ELAPSED=$(( $(date +%s) - START_TIME ))
echo "==> Done in $(( ELAPSED / 60 ))m $(( ELAPSED % 60 ))s."
