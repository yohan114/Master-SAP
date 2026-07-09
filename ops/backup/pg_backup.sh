#!/usr/bin/env bash
# UMMS PostgreSQL backup — compressed custom-format dump + checksum + retention.
# Optional at-rest encryption (age) and offsite copy. Exit non-zero on failure so cron alerts.
#
#   Env: PGHOST PGPORT PGUSER PGDATABASE (standard libpq vars) · BACKUP_DIR · RETENTION_DAYS
#        AGE_RECIPIENT (optional, encrypt at rest) · OFFSITE_CMD (optional, e.g. 'aws s3 cp')
#   Cron (hourly): 0 * * * *  BACKUP_DIR=/var/backups/umms /opt/umms/ops/backup/pg_backup.sh
set -euo pipefail

: "${PGDATABASE:=umms}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/umms}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
mkdir -p "$BACKUP_DIR"
LOG="$BACKUP_DIR/backup.log"
log() { echo "$(date -u +%FT%TZ) $*" | tee -a "$LOG" >&2; }
trap 'log "BACKUP FAILED (line $LINENO)"' ERR

ts="$(date -u +%Y%m%dT%H%M%SZ)"
file="$BACKUP_DIR/umms_${ts}.dump"

log "pg_dump ${PGDATABASE} -> ${file}"
pg_dump -Fc -Z6 --no-owner --no-privileges -f "$file" "$PGDATABASE"     # custom format = parallel/selective restore
sha256sum "$file" > "$file.sha256"
log "dump OK ($(du -h "$file" | cut -f1)); checksum written"

# Optional: encrypt at rest (age). Store the recipient's PUBLIC key only on the server.
if [ -n "${AGE_RECIPIENT:-}" ] && command -v age >/dev/null 2>&1; then
  age -r "$AGE_RECIPIENT" -o "$file.age" "$file" && rm -f "$file" && log "encrypted -> ${file}.age"
fi

# Optional: push offsite (3-2-1 rule). OFFSITE_CMD receives the file path as its last arg.
if [ -n "${OFFSITE_CMD:-}" ]; then
  for f in "$file" "$file.age" "$file.sha256"; do
    [ -e "$f" ] && $OFFSITE_CMD "$f" && log "offsite: $f"
  done
fi

# Retention: prune local dumps older than RETENTION_DAYS.
find "$BACKUP_DIR" -maxdepth 1 -name 'umms_*.dump*' -mtime +"$RETENTION_DAYS" -print -delete \
  | while read -r d; do log "pruned $d"; done || true

log "backup complete"
