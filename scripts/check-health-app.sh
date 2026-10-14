#!/usr/bin/env bash
# Sanity checks for the Container Health umbrelOS app, before pushing a new version.
#
# umbrelOS app updates only copy whitelisted files (docker-compose.yml, *.template,
# exports.sh, umbrel-app.yml, ...), so the server ships as server.mjs.template and
# is rendered with envsubst on install and update. envsubst replaces every $VAR /
# ${VAR}, so the template must not contain a dollar sign at all.
#
#   scripts/check-health-app.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/../localinfra-health" && pwd)"
TEMPLATE="$APP_DIR/server.mjs.template"
fail() { printf '\033[31m✘ %s\033[0m\n' "$*" >&2; exit 1; }
ok() { printf '\033[32m✔\033[0m %s\n' "$*"; }

[[ -f "$TEMPLATE" ]] || fail "$TEMPLATE missing"
[[ ! -e "$APP_DIR/server.mjs" ]] || fail "localinfra-health/server.mjs must not exist: updates would never refresh it (keep only server.mjs.template)"

if grep -n '\$' "$TEMPLATE"; then
  fail "server.mjs.template contains '\$' (lines above): envsubst would rewrite it. Use string concatenation instead of template literals."
fi
ok "no dollar signs in server.mjs.template"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
if command -v envsubst >/dev/null; then
  envsubst < "$TEMPLATE" > "$tmp/server.mjs"
  cmp -s "$TEMPLATE" "$tmp/server.mjs" || fail "envsubst changes server.mjs.template"
  ok "envsubst leaves it unchanged"
else
  cp "$TEMPLATE" "$tmp/server.mjs"
  echo "  (envsubst not installed here; skipped the render check)"
fi
node --check "$tmp/server.mjs" || fail "server.mjs.template is not valid JavaScript"
ok "valid JavaScript"

grep -q '/server.mjs:/app/server.mjs' "$APP_DIR/docker-compose.yml" || fail "docker-compose.yml must mount the rendered server.mjs"
ok "docker-compose.yml mounts the rendered file"
echo "Remember: bump 'version' in localinfra-health/umbrel-app.yml so Umbrel offers the update."
