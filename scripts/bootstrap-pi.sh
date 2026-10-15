#!/usr/bin/env bash
# One-shot, run from the Mac: bring up LocalInfra (Postgres, Redis, S3) on the Pi, provision yarg on it,
# point yarg's .env at LocalInfra and deploy yarg. Safe to re-run: each step checks first.
#
#   scripts/bootstrap-pi.sh
#
# Overridable: PI_SSH (default umbrel@umbrel.local), DOCKER_CONTEXT_NAME (default umbrel),
#              YARG_DIR (default ../music/yarg-aggregator next to this repo)
set -euo pipefail

PI_SSH="${PI_SSH:-umbrel@umbrel.local}"
CTX="${DOCKER_CONTEXT_NAME:-umbrel}"
INFRA_DIR="$(cd "$(dirname "$0")/.." && pwd)"
YARG_DIR="${YARG_DIR:-$INFRA_DIR/../music/yarg-aggregator}"

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32m✔\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31mSTOPPED:\033[0m %s\n' "$*" >&2; exit 1; }

# Read KEY from an env file without executing it
env_get() { sed -n "s/^$2=//p" "$1" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"; }

wait_healthy() { # container, max seconds
  local c=$1 max=$2 waited=0 s
  while :; do
    s=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$c" 2>/dev/null || echo missing)
    [[ "$s" == healthy ]] && { ok "$c is healthy"; return 0; }
    if (( waited >= max )) || [[ "$s" == exited || "$s" == dead || "$s" == unhealthy ]]; then
      echo "    last logs of $c:"; docker logs --tail 60 "$c" 2>&1 | sed 's/^/      /' || true
      die "$c did not become healthy (status: $s)"
    fi
    sleep 5; waited=$((waited + 5))
  done
}

# ------------------------------------------------------------------ preflight
step "Preflight"
command -v docker >/dev/null || die "docker CLI not found on this Mac (install/start Docker Desktop)."
[[ -f "$INFRA_DIR/.env" ]] || die "$INFRA_DIR/.env missing (copy .env.example)."
[[ -f "$YARG_DIR/docker-compose.yml" && -f "$YARG_DIR/.env" ]] || die "yarg not found at $YARG_DIR (set YARG_DIR=...)."
YARG_DIR="$(cd "$YARG_DIR" && pwd)"

ssh -o BatchMode=yes -o ConnectTimeout=10 "$PI_SSH" true 2>/dev/null \
  || die "SSH to $PI_SSH needs a password or fails. Run once:  ssh-copy-id $PI_SSH"
ok "SSH key login to $PI_SSH"

[[ "$(ssh "$PI_SSH" uname -m)" == aarch64 ]] || die "The Pi is not running a 64-bit OS."
ok "Pi is aarch64"

ssh -o BatchMode=yes "$PI_SSH" docker info >/dev/null 2>&1 \
  || die "'docker' on the Pi needs sudo for $PI_SSH. On the Pi run:  sudo usermod -aG docker \$USER  then log out/in."
ok "docker works on the Pi without sudo"

if ! docker context inspect "$CTX" >/dev/null 2>&1; then
  docker context create "$CTX" --docker "host=ssh://$PI_SSH" >/dev/null
  ok "created docker context '$CTX' -> ssh://$PI_SSH"
fi
export DOCKER_CONTEXT="$CTX"
[[ "$(docker info --format '{{.Architecture}}' 2>/dev/null)" == aarch64 ]] \
  || die "docker context '$CTX' does not reach the Pi. Check: docker context inspect $CTX"
ok "docker context '$CTX' reaches the Pi ($(docker info --format '{{.Name}}'))"

docker network inspect umbrel_main_network >/dev/null 2>&1 \
  || die "network umbrel_main_network not found on the Pi (yarg's compose joins it for the Cloudflare tunnel)."

# ------------------------------------------------------------------ drive folders
# BACKUP_DIR and S3_DATA_DIR must be on the external drive, each with its marker file (if the
# drive isn't mounted, Docker would silently create the folder on the SD card instead).
ensure_drive_dir() { # env key, marker file name
  local key=$1 marker=$2 dir src
  dir=$(env_get "$INFRA_DIR/.env" "$key")
  [[ -n "$dir" && "$dir" != /path/on/the/pi* ]] || die "Set $key in $INFRA_DIR/.env"
  src=$(ssh "$PI_SSH" "df -P '$(dirname "$dir")' 2>/dev/null | awk 'NR==2{print \$1}'")
  [[ -n "$src" ]] || die "$(dirname "$dir") does not exist on the Pi - is the drive mounted?"
  [[ "$src" != /dev/mmcblk* ]] || die "$(dirname "$dir") is on the SD card ($src), not the external drive."
  if ! ssh "$PI_SSH" "test -f '$dir/$marker'"; then
    ssh "$PI_SSH" "mkdir -p '$dir' && touch '$dir/$marker'" 2>/dev/null \
      || die "No permission to create it. On the Pi run:  sudo mkdir -p '$dir' && sudo touch '$dir/$marker'"
    ok "created $dir (+ marker)"
  fi
  ok "$key=$dir on $src"
}

step "Backup and S3 folders on the external drive"
ensure_drive_dir BACKUP_DIR .localinfra-backup-target
ensure_drive_dir S3_DATA_DIR .localinfra-s3-target

# ------------------------------------------------------------------ LocalInfra
step "Starting LocalInfra on the Pi"
(cd "$INFRA_DIR" && docker compose up -d --build)
wait_healthy localinfra-postgres 120
wait_healthy localinfra-redis 60
wait_healthy localinfra-s3 60
[[ "$(docker inspect -f '{{.State.Status}}' localinfra-backup)" == running ]] || die "localinfra-backup is not running"
ok "localinfra-backup is running"

# ------------------------------------------------------------------ provision yarg
step "Provisioning yarg on LocalInfra"
YARG_ENV="$YARG_DIR/.env"
yarg_db_url=$(env_get "$YARG_ENV" DATABASE_URL)
yarg_redis_pw=$(env_get "$YARG_ENV" REDIS_PASSWORD)
# Already provisioned = real credentials (not the <password> placeholders from .env.example)
if [[ "$yarg_db_url" == *@localinfra-postgres:* && "$yarg_db_url" != *"<password>"* \
   && "$(env_get "$YARG_ENV" REDIS_USERNAME)" == yarg && -n "$yarg_redis_pw" && "$yarg_redis_pw" != "<password>" ]]; then
  ok "yarg .env already points at LocalInfra - keeping its credentials"
else
  prov=$(mktemp)
  trap 'rm -f "$prov"' EXIT
  if ! bash "$INFRA_DIR/scripts/new-project.sh" yarg >"$prov" 2>/dev/null; then
    bash "$INFRA_DIR/scripts/new-project.sh" yarg --rotate >"$prov" \
      || die "provisioning yarg failed (see the error above)"   # role existed: new passwords
  fi
  grep -q '^DATABASE_URL=' "$prov" || die "provisioning produced no credentials"

  [[ -f "$YARG_DIR/.env.before-localinfra" ]] || cp -p "$YARG_ENV" "$YARG_DIR/.env.before-localinfra"
  tmp=$(mktemp)
  awk '
    NR==FNR { if (match($0, /^[A-Z_]+=/)) { k=substr($0,1,RLENGTH-1); v[k]=substr($0,RLENGTH+1); o[++n]=k }; next }
    match($0, /^[A-Z_]+=/) {
      k=substr($0,1,RLENGTH-1)
      if (k in v) { print k "=" v[k]; done[k]=1; next }
      if (k=="POSTGRES_USER" || k=="POSTGRES_PASSWORD" || k=="POSTGRES_DB") { print "# unused since LocalInfra: " $0; next }
    }
    { print }
    END { for (i=1;i<=n;i++) if (!(o[i] in done)) print o[i] "=" v[o[i]] }
  ' "$prov" "$YARG_ENV" > "$tmp"
  cat "$tmp" > "$YARG_ENV"; rm -f "$tmp"
  ok "yarg .env updated (old copy: .env.before-localinfra)"
fi

# ------------------------------------------------------------------ deploy yarg
step "Building and starting yarg on the Pi (the build runs on the Pi: several minutes)"
(cd "$YARG_DIR" && docker compose -f docker-compose.yml up -d --build)
wait_healthy yarg-aggregator 600
if docker exec yarg-aggregator wget -qO- http://127.0.0.1:3000/api/health >/dev/null; then ok "health endpoint answers"; else echo "    (health endpoint did not answer - check: docker logs yarg-aggregator)"; fi

# ------------------------------------------------------------------ first backup
step "Running a first backup"
docker exec localinfra-backup backup.sh || die "backup failed - see the output above"

# ------------------------------------------------------------------ summary
step "Done"
nets=$(docker inspect cloudflared_connector_1 --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null || true)
echo "    Cloudflare connector networks: ${nets:-<connector not found>}"
cat <<EOF

    Containers:  docker --context $CTX ps
    yarg logs:   docker --context $CTX logs -f yarg-aggregator
    In the Cloudflare tunnel, point yarg's hostname at:  http://yarg-aggregator:3000
EOF
