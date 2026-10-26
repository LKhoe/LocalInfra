#!/bin/sh
# Copies the newest Home Assistant backup into $BACKUP_ROOT/homeassistant/daily/<timestamp>/
# Home Assistant makes the backup itself (encrypted .tar, daily at 03:30) in its
# backups folder, mounted read-only at $HA_BACKUP_DIR. Same layout and retention as
# backup.sh: on the 1st of the month the set is also copied to monthly/, and old
# sets are pruned after BACKUP_KEEP_DAYS / BACKUP_KEEP_MONTHS.
set -eu

ROOT="${BACKUP_ROOT:-/backups}"
MARKER="$ROOT/.localinfra-backup-target"
SRC="${HA_BACKUP_DIR:-/homeassistant}"
MAX_AGE_HOURS="${HA_BACKUP_MAX_AGE_HOURS:-26}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
KEEP_MONTHS="${BACKUP_KEEP_MONTHS:-6}"

log() { echo "[backup-ha $(date '+%Y-%m-%d %H:%M:%S')] $*"; }

STATUS_JOB=homeassistant
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

newest=$(ls -t "$SRC"/*.tar 2>/dev/null | head -n 1 || true)
if [ -z "$newest" ]; then
  STATUS_ERROR="no Home Assistant backup (*.tar) in its backups folder"
  log "ERROR: no Home Assistant backup (*.tar) found in $SRC"
  exit 1
fi

# A stale file means Home Assistant stopped making backups; say so instead of
# quietly copying the same old backup every night.
if [ -z "$(find "$newest" -mmin -"$((MAX_AGE_HOURS * 60))")" ]; then
  STATUS_ERROR="newest Home Assistant backup $(basename "$newest") is older than ${MAX_AGE_HOURS}h: Home Assistant stopped backing up"
  log "ERROR: newest backup $(basename "$newest") is older than ${MAX_AGE_HOURS}h - check Home Assistant backups"
  exit 1
fi

umask 077
STAMP=$(date +%Y-%m-%d_%H%M)
DAILY="$ROOT/homeassistant/daily"
MONTHLY="$ROOT/homeassistant/monthly"
TMP="$ROOT/homeassistant/.tmp-$STAMP"
DEST="$DAILY/$STAMP"

mkdir -p "$DAILY" "$MONTHLY"
rm -rf "$TMP"
mkdir -p "$TMP"

STATUS_STEP="copying $(basename "$newest")"
log "copying $(basename "$newest")"
cp "$newest" "$TMP/"   # plain copy: exFAT/NTFS drives reject ownership changes
STATUS_STEP="checking the copy of $(basename "$newest")"
tar -tf "$TMP/$(basename "$newest")" > /dev/null   # fails on a truncated/corrupt copy

STATUS_STEP="moving the set into place"
rm -rf "$DEST"
mv "$TMP" "$DEST"
TMP=""

if [ "$(date +%d)" = "01" ]; then
  rm -rf "$MONTHLY/$STAMP"
  cp -R "$DEST" "$MONTHLY/$STAMP"
  log "monthly copy kept: $MONTHLY/$STAMP"
fi

STATUS_STEP="pruning old sets"
find "$DAILY" -mindepth 1 -maxdepth 1 -type d -mtime +"$KEEP_DAYS" -exec rm -rf {} +
find "$MONTHLY" -mindepth 1 -maxdepth 1 -type d -mtime +"$((KEEP_MONTHS * 31))" -exec rm -rf {} +

date '+%Y-%m-%dT%H:%M:%S%z' > "$ROOT/homeassistant/last_success"
STATUS_SET="daily/$STAMP"
log "done: $DEST ($(du -sh "$DEST" | cut -f1))"
