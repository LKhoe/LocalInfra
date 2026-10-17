#!/bin/sh
# Runs backup.sh and backup-homeassistant.sh on BACKUP_CRON using busybox crond
# (PID 1, foreground). Each runs even if the other fails.
set -eu

BACKUP_CRON="${BACKUP_CRON:-0 4 * * *}"

# busybox crond starts jobs with an almost empty environment, so the connection
# settings (PGHOST, PGPASSWORD, ...) are handed over through a root-only file.
umask 077
export -p > /run/backup.env

mkdir -p /etc/crontabs
echo "$BACKUP_CRON . /run/backup.env; /usr/local/bin/backup.sh > /proc/1/fd/1 2>&1; /usr/local/bin/backup-homeassistant.sh > /proc/1/fd/1 2>&1" > /etc/crontabs/root

echo "[backup] schedule '$BACKUP_CRON' (TZ=${TZ:-UTC}) -> /backups/postgres, /backups/homeassistant"
echo "[backup] run now with: docker exec localinfra-backup backup.sh"
echo "[backup]          and: docker exec localinfra-backup backup-homeassistant.sh"

if [ "${BACKUP_ON_START:-false}" = "true" ]; then
  /usr/local/bin/backup.sh || echo "[backup] initial backup failed"
  /usr/local/bin/backup-homeassistant.sh || echo "[backup] initial Home Assistant copy failed"
fi

exec crond -f -l 8 -L /dev/stderr -c /etc/crontabs
