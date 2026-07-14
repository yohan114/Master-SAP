# 003 — Legacy tracker MRN import

Imports Stores **MRN / receipt** data from a `tracker_backup_*.json` export into a self-contained
`stg_*` staging schema.

## Run it

```bash
cd app && npm install                 # nothing new to install (built-in JSON.parse; no stream-json)

# SQLite
export DB_ENGINE=sqlite SQLITE_DB=./umms.sqlite
node ../migrations/003-tracker-mrn/migrate-tracker-backup.js \
     ../migrations/003-tracker-mrn/source/tracker_backup_2026-07-12.json

# PostgreSQL
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGDATABASE=umms
node ../migrations/003-tracker-mrn/migrate-tracker-backup.js /path/to/tracker_backup.json
```

The script creates the schema itself (idempotent); `003-tracker-mrn-tables.sql` is provided if you'd
rather pre-create it (`psql -d umms -f 003-tracker-mrn-tables.sql`). Each MRN is imported in **its own
transaction** (a failure rolls back that MRN, logs it, and the run continues); re-running is safe (an
MRN already in `stg_mrn` is skipped). A CSV report lands in `./exports/` (git-ignored).

## Validated on the real export (identical on SQLite and PostgreSQL)

```
Total MRNs processed : 1341    Imported 1341 | Skipped 0 | Failed 0
Records with no mrnNum: 87     (flagged, not dropped)
Line items 3967 · Receipts 3188 · Unpriced receipts 1340 · 1 non-'Receive' flagged
Status: FULFILLED 738 · PARTIAL 389 · PENDING 214
Assets 632 · Departments 147 · Items 2732
```

## Decisions & deviations from the original spec (why)

The spec targeted a repo layout and tables that don't exist here; every change below is deliberate.

- **Staging tables, not the live Stores module.** The spec's `stores_mrn` / `mrn_line_items` /
  `grn_receipts` don't exist; the live tables are **`tx_mrn` / `txl_mrn` / `tx_grn`** wired into the
  **moving-average inventory engine**. Replaying 3,188 receipts (1,340 of them **unpriced**) into the
  live ledger would revalue real stock and can't be undone. So the import lands in reversible `stg_*`
  staging tables; the importer **matches** each item/asset to the live master *read-only* and records
  `matched_item_id` / `matched_asset_id` for a later, deliberate reconciliation into `tx_mrn` / `md_item`
  / `md_asset`. Ask if you want that reconciliation built.
- **`~10,000+ records` → actually 4,054** (1,342 MRNs). At 3 MB the file is read with built-in
  `JSON.parse` — **no `stream-json` dependency**; MRNs are processed one transaction at a time.
- **DB access via the app's `db.js`** (the repo has no `src/config/database.js`), so the same script
  runs on PostgreSQL *or* SQLite. Case-insensitive matching uses `LOWER(...) = LOWER(...)`, not `ILIKE`.
- **`md_item` / `md_asset` mapping** uses the real columns (`item_name`, `asset_no`) — there is no
  `item_description` / `unit_of_measure` / `category` / `asset_code` column on the live tables; those
  live on the staging rows (`item_description`, `uom`, `category_code`, `asset_code`).
- **Categories** map per the spec, plus **Belts → belts** and **Tyre → tyre** (both present in the data,
  absent from the spec's map; they'd otherwise fall to `general_items`).
- **Data quality:** empty strings → `NULL`; unpriced receipts flagged (`is_priced=false`); the **1
  `Return`** receipt (spec said "always Receive") is counted + flagged; **87 records with no `mrnNum`**
  are logged to `stg_import_log` and the CSV (not silently dropped); dashless/mapped `vehicleMachinery`
  values become departments (`WS-STR`, `WS-MCH`, …) rather than assets.

## ⚠️ Data safety

`tracker_backup_*.json` and the generated `exports/*.csv` are **real operational data** and are **not
committed** (`source/` and `exports/*.csv` are git-ignored). Only the code (script + schema) is in git.
