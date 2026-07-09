#!/usr/bin/env bash
# UMMS restore drill — restores the latest backup into a scratch DB and verifies it matches
# the live DB. Run on a schedule; an untested backup is not a backup. Exit non-zero on mismatch.
#
#   Usage: [BACKUP_DIR=...] [TEST_DB=umms_restore_test] pg_restore_drill.sh [dumpfile]
set -euo pipefail

: "${PGDATABASE:=umms}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/umms}"
TEST_DB="${TEST_DB:-umms_restore_test}"

file="${1:-$(ls -1t "$BACKUP_DIR"/umms_*.dump 2>/dev/null | head -1 || true)}"
[ -n "$file" ] && [ -e "$file" ] || { echo "no backup file found in $BACKUP_DIR"; exit 1; }
echo "restore drill using: $file"

# integrity: verify checksum if present
if [ -e "$file.sha256" ]; then ( cd "$(dirname "$file")" && sha256sum -c "$(basename "$file").sha256" ); fi

dropdb --if-exists "$TEST_DB"
createdb "$TEST_DB"
pg_restore --no-owner --no-privileges -d "$TEST_DB" "$file"

fail=0
for t in md_item md_asset md_employee tx_jobcard tx_job_labour cost_job_summary mv_stock_ledger inv_stock_balance; do
  a=$(psql -d "$PGDATABASE" -tAc "SELECT count(*) FROM $t")
  b=$(psql -d "$TEST_DB"    -tAc "SELECT count(*) FROM $t")
  if [ "$a" = "$b" ]; then printf '  OK    %-18s %s\n' "$t" "$a"; else printf '  FAIL  %-18s live=%s restored=%s\n' "$t" "$a" "$b"; fail=1; fi
done
va=$(psql -d "$PGDATABASE" -tAc "SELECT COALESCE(SUM(stock_value),0)::numeric(18,2) FROM inv_stock_balance")
vb=$(psql -d "$TEST_DB"    -tAc "SELECT COALESCE(SUM(stock_value),0)::numeric(18,2) FROM inv_stock_balance")
if [ "$va" = "$vb" ]; then printf '  OK    %-18s %s\n' "stock_value" "$va"; else printf '  FAIL  stock_value live=%s restored=%s\n' "$va" "$vb"; fail=1; fi

dropdb --if-exists "$TEST_DB"
if [ "$fail" = 0 ]; then echo "RESTORE DRILL PASSED"; else echo "RESTORE DRILL FAILED"; exit 1; fi
