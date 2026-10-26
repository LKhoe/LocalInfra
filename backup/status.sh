#!/bin/sh
# Sourced by backup.sh and backup-homeassistant.sh: records the result of every run, good or
# not, as JSON for the Container Health status page (it reads it through Docker's read-only
# archive endpoint, the same way `docker cp` would).
#   /run/backup-status/<job>.json   every run, even when the external drive is missing
#   $ROOT/<job>/last_success.json   every good run: what the newest set holds (survives restarts)
# $ROOT/<job>/last_success stays the healthcheck's timestamp.
#
# The caller sets STATUS_JOB, STATUS_STEP (what it is doing, for the error message) and on
# success STATUS_SET (the folder it wrote); STATUS_ERROR overrides the error text.

STATUS_STARTED=$(date +%s)
STATUS_STEP="starting"
STATUS_SET=""
STATUS_ERROR=""

json_str() { printf '"%s"' "$(printf '%s' "$1" | tr -d '\n\r\t' | sed 's/\\/\\\\/g; s/"/\\"/g')"; }
count_dirs() { [ -d "$1" ] && find "$1" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ' || echo 0; }

# write_status <exit code>
write_status() {
  rc=$1
  ok=false
  error=""
  [ "$rc" -eq 0 ] && ok=true || error="${STATUS_ERROR:-failed while $STATUS_STEP}"

  files=""
  bytes=0
  if [ "$ok" = true ] && [ -n "$STATUS_SET" ] && [ -d "$ROOT/$STATUS_JOB/$STATUS_SET" ]; then
    for f in "$ROOT/$STATUS_JOB/$STATUS_SET"/*; do
      [ -f "$f" ] || continue
      size=$(stat -c %s "$f" 2>/dev/null || echo 0)
      bytes=$((bytes + size))
      files="$files${files:+,}{\"name\":$(json_str "$(basename "$f")"),\"bytes\":$size}"
    done
  fi

  json="{\"job\":$(json_str "$STATUS_JOB"),\"ok\":$ok,\"started\":$STATUS_STARTED,\"finished\":$(date +%s)"
  json="$json,\"error\":$(json_str "$error"),\"set\":$(json_str "$STATUS_SET"),\"bytes\":$bytes,\"files\":[$files]"
  json="$json,\"schedule\":$(json_str "${BACKUP_CRON:-}"),\"keepDays\":${KEEP_DAYS:-0},\"keepMonths\":${KEEP_MONTHS:-0}"
  if [ -f "$MARKER" ]; then
    json="$json,\"daily\":$(count_dirs "$ROOT/$STATUS_JOB/daily"),\"monthly\":$(count_dirs "$ROOT/$STATUS_JOB/monthly")"
  fi
  json="$json}"

  mkdir -p /run/backup-status
  printf '%s\n' "$json" > "/run/backup-status/$STATUS_JOB.json"
  if [ "$ok" = true ] && [ -f "$MARKER" ] && [ -d "$ROOT/$STATUS_JOB" ]; then
    printf '%s\n' "$json" > "$ROOT/$STATUS_JOB/last_success.json"
  fi
}
