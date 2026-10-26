#!/bin/sh
# Dumps roles + every database into $BACKUP_ROOT/postgres/daily/<timestamp>/
#   globals.sql      roles and their password hashes (pg_dumpall --globals-only)
#   <db>.dump        one custom-format dump per database (restore with pg_restore)
# On the 1st of the month the set is also copied to monthly/.
# Old sets are pruned after BACKUP_KEEP_DAYS / BACKUP_KEEP_MONTHS.
set -eu

ROOT="${BACKUP_ROOT:-/backups}"
MARKER="$ROOT/.localinfra-backup-target"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
KEEP_MONTHS="${BACKUP_KEEP_MONTHS:-6}"

log() { echo "[backup $(date '+%Y-%m-%d %H:%M:%S')] $*"; }

STATUS_JOB=postgres
. /usr/local/lib/backup-status.sh
TMP=""
trap 'rc=$?; [ -z "$TMP" ] || rm -rf "$TMP"; write_status "$rc"; exit "$rc"' EXIT

# If the external drive is not mounted, Docker silently creates an empty folder on
# the SD card / system disk instead. The marker file only exists on the real drive.
if [ ! -f "$MARKER" ]; then
  STATUS_ERROR="external drive not mounted (no .localinfra-backup-target in the backup folder)"
  log "ERROR: $MARKER not found - is the external drive mounted? Not writing anything."
  exit 1
fi

umask 077
STAMP=$(date +%Y-%m-%d_%H%M)
DAILY="$ROOT/postgres/daily"
MONTHLY="$ROOT/postgres/monthly"
TMP="$ROOT/postgres/.tmp-$STAMP"
DEST="$DAILY/$STAMP"

mkdir -p "$DAILY" "$MONTHLY"
rm -rf "$TMP"
mkdir -p "$TMP"

STATUS_STEP="dumping roles"
log "dumping roles"
pg_dumpall --globals-only --file="$TMP/globals.sql"

STATUS_STEP="listing the databases"
dbs=$(psql -X -d postgres -Atc \
  "SELECT datname FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres' ORDER BY 1")

for db in $dbs; do
  STATUS_STEP="dumping $db"
  log "dumping $db"
  pg_dump --format=custom --dbname="$db" --file="$TMP/$db.dump"
done

STATUS_STEP="moving the set into place"
rm -rf "$DEST"
mv "$TMP" "$DEST"
TMP=""

if [ "$(date +%d)" = "01" ]; then
  rm -rf "$MONTHLY/$STAMP"
  cp -R "$DEST" "$MONTHLY/$STAMP"   # plain copy: exFAT/NTFS drives reject ownership changes
  log "monthly copy kept: $MONTHLY/$STAMP"
fi

STATUS_STEP="pruning old sets"
find "$DAILY" -mindepth 1 -maxdepth 1 -type d -mtime +"$KEEP_DAYS" -exec rm -rf {} +
find "$MONTHLY" -mindepth 1 -maxdepth 1 -type d -mtime +"$((KEEP_MONTHS * 31))" -exec rm -rf {} +

date '+%Y-%m-%dT%H:%M:%S%z' > "$ROOT/postgres/last_success"
STATUS_SET="daily/$STAMP"
log "done: $DEST ($(du -sh "$DEST" | cut -f1), databases: $(echo $dbs | tr ' ' ','))"
