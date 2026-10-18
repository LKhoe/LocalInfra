#!/usr/bin/env bash
# Provision an app on LocalInfra AND write its credentials into the app's .env, in one step.
# This is step 2 of DEPLOYING-APPS.md. It wraps new-project.sh, so the same flags apply.
#
# Usage (from anywhere, on the Mac):
#   DOCKER_CONTEXT=umbrel scripts/provision-app.sh <name> <app-dir> [--no-redis] [--s3] [--llm] [--rotate] [--no-postgres]
#
#   <name>     project name: database, role, Redis user, S3 key and LLM key ([a-z][a-z0-9_]*)
#   <app-dir>  the app's repo; its .env is created from .env.example if missing
#
# What it does to <app-dir>/.env:
#   - keeps a copy first (.env.bak-<timestamp>)
#   - replaces the keys new-project.sh prints (DATABASE_URL, POSTGRES_*, REDIS_*, S3_*, LLM_*) and
#     appends the ones that weren't there; every other line is left as it was
#   - comments out POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB (an app-owned Postgres)
#   - with --llm: removes OPENROUTER_API_KEY / OPENROUTER_MODEL (the gateway holds the key)
#   - then warns about values that still look local or like placeholders
#
# Re-running for an existing project needs --rotate (new passwords/keys, data untouched).
set -euo pipefail

INFRA_DIR="$(cd "$(dirname "$0")/.." && pwd)"

usage() { sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

[[ $# -ge 2 ]] || usage
name=$1; app_dir=$2; shift 2
[[ -d "$app_dir" ]] || { echo "App folder not found: $app_dir" >&2; exit 1; }
app_dir="$(cd "$app_dir" && pwd)"
env_file="$app_dir/.env"

echo "Docker context: ${DOCKER_CONTEXT:-$(docker context show)}" >&2

if [[ ! -f "$env_file" ]]; then
  [[ -f "$app_dir/.env.example" ]] || { echo "No .env or .env.example in $app_dir" >&2; exit 1; }
  cp "$app_dir/.env.example" "$env_file"
  echo "Created $env_file from .env.example" >&2
fi

creds=$(mktemp)
trap 'rm -f "$creds"' EXIT
# new-project.sh prints the env block on stdout and its progress on stderr
bash "$INFRA_DIR/scripts/new-project.sh" "$name" "$@" >"$creds"
grep -qE '^(DATABASE_URL|REDIS_PASSWORD|S3_SECRET_ACCESS_KEY|LLM_API_KEY)=' "$creds" \
  || { echo "new-project.sh printed no credentials" >&2; exit 1; }

backup="$env_file.bak-$(date +%Y%m%d-%H%M%S)"
n=1; base=$backup
while [[ -e "$backup" ]]; do backup="$base-$((n++))"; done   # never overwrite an older backup
cp -p "$env_file" "$backup"
# The backup holds secrets: make sure git would never pick it up
if git -C "$app_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
   && ! git -C "$app_dir" check-ignore -q "$backup"; then
  echo "WARNING: $(basename "$backup") is not git-ignored. Add this line to $app_dir/.gitignore:  .env.bak-*" >&2
fi

tmp=$(mktemp)
awk '
  NR == FNR { if (match($0, /^[A-Z0-9_]+=/)) { k = substr($0, 1, RLENGTH - 1); v[k] = substr($0, RLENGTH + 1); o[++n] = k }; next }
  match($0, /^[A-Z0-9_]+=/) {
    k = substr($0, 1, RLENGTH - 1)
    if (k in v) { print k "=" v[k]; done[k] = 1; next }
    if (k == "POSTGRES_USER" || k == "POSTGRES_PASSWORD" || k == "POSTGRES_DB") { print "# unused since LocalInfra: " $0; next }
    # The app calls the LLM gateway now; its own OpenRouter key (a secret) is dropped
    if ((k == "OPENROUTER_API_KEY" || k == "OPENROUTER_MODEL") && ("LLM_API_KEY" in v)) { print "# " k "= (removed: LocalInfra LLM gateway)"; next }
  }
  { print }
  END {
    first = 1
    for (i = 1; i <= n; i++) if (!(o[i] in done)) {
      if (first) { print ""; print "# ---- added by LocalInfra/scripts/provision-app.sh ----"; first = 0 }
      print o[i] "=" v[o[i]]
    }
  }
' "$creds" "$env_file" >"$tmp"
cat "$tmp" >"$env_file"   # keep the original file's permissions
rm -f "$tmp"

echo >&2
echo "Updated $env_file (previous version: $(basename "$backup"))." >&2
echo "Credentials written: $(grep -oE '^[A-Z0-9_]+=' "$creds" | tr -d '=' | tr '\n' ' ')" >&2

# Anything still pointing at the Mac or left as a placeholder will break the deploy
suspicious=$(grep -nE '^[A-Z0-9_]+=.*(localhost|127\.0\.0\.1|<[a-z ]+>|replace-with|example\.com)' "$env_file" \
  | sed -E 's/^([0-9]+):([A-Z0-9_]+)=.*/  line \1: \2/' || true)
if [[ -n "$suspicious" ]]; then
  echo >&2
  echo "Still to fill in for the Pi (local values or placeholders):" >&2
  echo "$suspicious" >&2
fi

nets=()
grep -q '^DATABASE_URL=' "$creds" && nets+=(localinfra_postgres)
grep -q '^REDIS_' "$creds" && nets+=(localinfra_redis)
grep -q '^S3_' "$creds" && nets+=(localinfra_s3)
grep -q '^LLM_' "$creds" && nets+=(localinfra_llm)
echo >&2
echo "The app's docker-compose.yml must join these external networks: ${nets[*]}" >&2
