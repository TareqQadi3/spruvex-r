#!/bin/sh
# Runs one backup of the SpruVex R production database, connecting directly
# over the network (no `docker compose exec`, so this also works from inside
# the `backup` sidecar container defined in docker-compose.prod.yml).
#
# Required env: PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE
# Optional env: BACKUP_DIR (default /backups), RETENTION_DAYS (default 14)
set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

mkdir -p "$BACKUP_DIR"
timestamp="$(date +%Y%m%d-%H%M%S)"
out_file="$BACKUP_DIR/spruvex-r-$timestamp.dump"

echo "[backup] dumping ${PGDATABASE:?required} on ${PGHOST:?required}:${PGPORT:?required} -> $out_file"
pg_dump --format=custom -h "$PGHOST" -p "$PGPORT" -U "${PGUSER:?required}" "$PGDATABASE" > "$out_file"

# Fail loudly on an empty/truncated dump rather than silently keeping a
# useless backup file around.
if [ ! -s "$out_file" ]; then
  echo "[backup] ERROR: $out_file is empty — dump likely failed" >&2
  rm -f "$out_file"
  exit 1
fi
echo "[backup] OK: $(du -h "$out_file" | cut -f1)"

echo "[backup] pruning dumps older than $RETENTION_DAYS days in $BACKUP_DIR"
find "$BACKUP_DIR" -name 'spruvex-r-*.dump' -mtime "+$RETENTION_DAYS" -print -delete

echo "[backup] done. Remember: copy $BACKUP_DIR off this host (S3 or similar) —"
echo "[backup] a backup that lives only on the machine it protects against isn't one."
