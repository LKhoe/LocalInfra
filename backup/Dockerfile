# Same major version as the server, so pg_dump is always compatible.
ARG PG_VERSION=17
FROM postgres:${PG_VERSION}-alpine

# tzdata so BACKUP_CRON runs in your local time (TZ in .env)
RUN apk add --no-cache tzdata

COPY entrypoint.sh /usr/local/bin/backup-entrypoint
COPY backup.sh /usr/local/bin/backup.sh
COPY backup-homeassistant.sh /usr/local/bin/backup-homeassistant.sh
RUN chmod 755 /usr/local/bin/backup-entrypoint /usr/local/bin/backup.sh /usr/local/bin/backup-homeassistant.sh

ENTRYPOINT ["backup-entrypoint"]
CMD []
