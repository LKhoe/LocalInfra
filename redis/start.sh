#!/bin/sh
# Starts Redis with ACLs enabled.
#  - "default" is the admin user; its password always comes from REDIS_ADMIN_PASSWORD
#    (rewritten on every start, so changing it in .env + restarting is enough).
#  - Project users are added by scripts/new-project.sh (ACL SETUSER + ACL SAVE) and
#    persisted in /data/users.acl, next to the AOF data.
set -eu

: "${REDIS_ADMIN_PASSWORD:?REDIS_ADMIN_PASSWORD must be set}"
ACL_FILE="${ACL_FILE:-/data/users.acl}"

touch "$ACL_FILE"
others=$(grep -v '^user default ' "$ACL_FILE" || true)
{
  echo "user default on >${REDIS_ADMIN_PASSWORD} ~* &* +@all"
  if [ -n "$others" ]; then printf '%s\n' "$others"; fi
} > "$ACL_FILE.tmp"
mv "$ACL_FILE.tmp" "$ACL_FILE"
chmod 600 "$ACL_FILE"

# The official entrypoint fixes /data ownership and drops to the "redis" user.
# noeviction: BullMQ (and any queue) must never have keys silently evicted.
exec "${REDIS_ENTRYPOINT:-docker-entrypoint.sh}" redis-server \
  --appendonly yes \
  --maxmemory "${REDIS_MAXMEMORY:-256mb}" \
  --maxmemory-policy noeviction \
  --aclfile "$ACL_FILE"
