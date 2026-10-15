#!/usr/bin/env bash
# Provision an isolated project on LocalInfra and print the env vars it needs.
#
#   Postgres: role <name> (LOGIN, no superuser/createdb/createrole) owning database <name>.
#             CONNECT is revoked from PUBLIC, so other projects' roles can't even connect.
#   Redis:    ACL user <name>, limited to keys and pub/sub channels "<name>:*",
#             with admin commands and FLUSHALL/FLUSHDB blocked.
#   S3:       (opt-in, --s3) Garage bucket <name with _ -> -> and access key <name>, allowed to
#             read/write that bucket only: it can't see other buckets, create or delete buckets.
#
# Usage:
#   scripts/new-project.sh <name> [--rotate] [--no-postgres] [--no-redis] [--s3]
#
#   --rotate       project already exists: issue new passwords/keys (data is untouched)
#   --no-postgres  skip the Postgres role + database
#   --no-redis     skip the Redis user
#   --s3           also create the S3 bucket + access key (Garage)
#
# Runs against whatever your docker CLI points at: on the Pi itself, or from the
# Mac with  DOCKER_CONTEXT=umbrel scripts/new-project.sh <name>
set -euo pipefail

cd "$(dirname "$0")/.."

PG_CONTAINER=localinfra-postgres
REDIS_CONTAINER=localinfra-redis
S3_CONTAINER=localinfra-s3

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

# Read KEY from .env without executing it (values may contain spaces, "*", ...)
env_get() {
  [[ -f .env ]] || return 0
  sed -n "s/^$1=//p" .env | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

gen_password() { head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

name=""; rotate=false; want_pg=true; want_redis=true; want_s3=false
for arg in "$@"; do
  case "$arg" in
    --rotate) rotate=true ;;
    --no-postgres) want_pg=false ;;
    --no-redis) want_redis=false ;;
    --s3) want_s3=true ;;
    -h|--help) usage ;;
    -*) echo "Unknown option: $arg" >&2; usage ;;
    *) [[ -z "$name" ]] || usage; name="$arg" ;;
  esac
done

if [[ ! "$name" =~ ^[a-z][a-z0-9_]{1,30}$ ]]; then
  echo "Project name must match ^[a-z][a-z0-9_]{1,30}\$ (lowercase, digits, underscore)." >&2
  usage
fi
case "$name" in
  postgres|template0|template1|public|default|admin|root)
    echo "\"$name\" is reserved." >&2; exit 1 ;;
esac

require_healthy() {
  local status
  status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$1" 2>/dev/null || true)
  if [[ "$status" != "healthy" ]]; then
    echo "Container $1 is not healthy (status: ${status:-missing}). Start LocalInfra first: docker compose up -d" >&2
    exit 1
  fi
}

PG_SUPER=$(env_get POSTGRES_SUPERUSER); PG_SUPER=${PG_SUPER:-postgres}
REDIS_ADMIN_PASSWORD=$(env_get REDIS_ADMIN_PASSWORD)

psql_admin() {
  docker exec -i "$PG_CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U "$PG_SUPER" -d postgres "$@"
}
redis_admin() {
  # Password passed through the environment, not the command line.
  REDISCLI_AUTH="$REDIS_ADMIN_PASSWORD" docker exec -i -e REDISCLI_AUTH "$REDIS_CONTAINER" \
    redis-cli --no-auth-warning "$@"
}

# ---------------------------------------------------------------- Postgres
if $want_pg; then
  require_healthy "$PG_CONTAINER"
  exists=$(psql_admin -Atc "SELECT 1 FROM pg_roles WHERE rolname = '$name'")
  if [[ "$exists" == "1" && "$rotate" != true ]]; then
    echo "Postgres role \"$name\" already exists. Use --rotate to issue a new password." >&2
    exit 1
  fi

  PG_PASSWORD=$(gen_password)
  {
    printf '\\set name %s\n\\set pass %s\n' "$name" "$PG_PASSWORD"
    cat <<'SQL'
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 20', :'name')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'name') \gexec
SELECT format('ALTER ROLE %I PASSWORD %L', :'name', :'pass') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'name', :'name')
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'name') \gexec
-- Only the owner (and the superuser) may connect to a project database.
REVOKE ALL ON DATABASE :"name" FROM PUBLIC;
REVOKE ALL ON DATABASE postgres FROM PUBLIC;
\connect :"name"
REVOKE ALL ON SCHEMA public FROM PUBLIC;
SQL
  } | psql_admin
  echo "Postgres: role + database \"$name\" ready." >&2
fi

# ---------------------------------------------------------------- Redis
if $want_redis; then
  require_healthy "$REDIS_CONTAINER"
  if [[ -z "$REDIS_ADMIN_PASSWORD" ]]; then
    echo "REDIS_ADMIN_PASSWORD not found in .env" >&2; exit 1
  fi
  exists=$(redis_admin ACL GETUSER "$name" | head -n 1)
  if [[ -n "$exists" && "$rotate" != true ]]; then
    echo "Redis user \"$name\" already exists. Use --rotate to issue a new password." >&2
    exit 1
  fi

  REDIS_PASSWORD=$(gen_password)
  redis_admin ACL SETUSER "$name" reset on ">$REDIS_PASSWORD" \
    "~$name:*" "&$name:*" \
    "+@all" "-@admin" "-flushall" "-flushdb" "-swapdb" >/dev/null
  redis_admin ACL SAVE >/dev/null
  echo "Redis: user \"$name\" ready (keys/channels \"$name:*\")." >&2
fi

# ---------------------------------------------------------------- S3 (Garage)
# Bucket names can't contain "_" (S3 naming rules); the key keeps the project name.
S3_BUCKET=${name//_/-}
s3_admin() {
  # The CLI talks to the node over RPC; the container's own GARAGE_RPC_SECRET authenticates it.
  docker exec -i "$S3_CONTAINER" garage "$@"
}
# Exact-name lookup: "garage key info <pattern>" also matches name/ID prefixes.
s3_key_id() {
  s3_admin key list | awk -v n="$1" 'NR > 1 && $3 == n { print $1 }'
}
if $want_s3; then
  require_healthy "$S3_CONTAINER"
  old_key_id=$(s3_key_id "$name")
  if [[ -n "$old_key_id" && "$rotate" != true ]]; then
    echo "S3 key \"$name\" already exists. Use --rotate to issue a new one." >&2
    exit 1
  fi

  s3_admin bucket info "$S3_BUCKET" >/dev/null 2>&1 || s3_admin bucket create "$S3_BUCKET" >/dev/null
  # Rotation = a new key pair; the bucket and its objects are untouched.
  [[ -n "$old_key_id" ]] && s3_admin key delete --yes "$old_key_id" >/dev/null

  created=$(s3_admin key create "$name")
  S3_KEY_ID=$(awk -F': *' '/^Key ID:/ { print $2 }' <<<"$created")
  S3_SECRET=$(awk -F': *' '/^Secret key:/ { print $2 }' <<<"$created")
  if [[ ! "$S3_KEY_ID" =~ ^GK[0-9a-f]+$ || ! "$S3_SECRET" =~ ^[0-9a-f]{64}$ ]]; then
    echo "Could not read the new S3 key from garage's output:" >&2
    echo "$created" | grep -v '^Secret key' >&2
    exit 1
  fi
  # read + write only: no --owner, so the key can't delete the bucket or change its settings
  s3_admin bucket allow --read --write "$S3_BUCKET" --key "$S3_KEY_ID" >/dev/null
  echo "S3: bucket \"$S3_BUCKET\" + key \"$name\" ($S3_KEY_ID) ready (read/write on that bucket only)." >&2
fi

# ---------------------------------------------------------------- Output
echo >&2
echo "# ---- add to the project's .env (on the machine that runs its compose) ----" >&2
if $want_pg; then
  cat <<EOF
DATABASE_URL=postgresql://$name:$PG_PASSWORD@$PG_CONTAINER:5432/$name
POSTGRES_HOST=$PG_CONTAINER
POSTGRES_PORT=5432
EOF
fi
if $want_redis; then
  cat <<EOF
REDIS_HOST=$REDIS_CONTAINER
REDIS_PORT=6379
REDIS_USERNAME=$name
REDIS_PASSWORD=$REDIS_PASSWORD
REDIS_KEY_PREFIX=$name:
EOF
fi
if $want_s3; then
  cat <<EOF
S3_ENDPOINT=http://$S3_CONTAINER:3900
S3_REGION=garage
S3_BUCKET=$S3_BUCKET
S3_ACCESS_KEY_ID=$S3_KEY_ID
S3_SECRET_ACCESS_KEY=$S3_SECRET
EOF
fi
echo >&2
nets=()
$want_pg && nets+=("localinfra_postgres")
$want_redis && nets+=("localinfra_redis")
$want_s3 && nets+=("localinfra_s3")
echo "# and join the external network(s): ${nets[*]}" >&2
