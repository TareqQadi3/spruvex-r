#!/bin/sh
# Entrypoint for the `backup` sidecar service in docker-compose.prod.yml.
# Installs a crontab that runs backup-once.sh on a schedule, then runs
# busybox crond in the foreground so the container stays up on its own —
# no host crontab or manual step required to get periodic backups running.
set -eu

BACKUP_SCHEDULE="${BACKUP_SCHEDULE:-0 3 * * *}"

echo "$BACKUP_SCHEDULE /usr/local/bin/backup-once.sh >> /proc/1/fd/1 2>> /proc/1/fd/2" > /etc/crontabs/root

echo "[backup] cron installed: '$BACKUP_SCHEDULE' -> ${BACKUP_DIR:-/backups} (retention ${RETENTION_DAYS:-14}d)"
echo "[backup] running one backup now to verify the connection before waiting for the schedule"
/usr/local/bin/backup-once.sh || echo "[backup] initial backup failed — see error above; cron will keep retrying on schedule" >&2

exec crond -f -l 8
