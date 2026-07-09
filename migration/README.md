# UMMS — Legacy Data Migration (playbook + tested ETLs)

Reference importers that map the four legacy sources into the UMMS canonical model
(`sql/schema.sql`, `docs/03`). Each script was **run against the real exports** and reconciles;
numbers below are from those runs. See `docs/08-data-migration.md` for the staging/cutover strategy.

> **Note:** these scripts read from a local `data/` folder (place the source exports there) and
> print a reconciliation report + emit canonical JSON. They do **not** contain any operational
> data — only the mapping logic. Do not commit the source `.xlsx` / `.db` exports.

## Sources → targets

| Script | Source export | → UMMS targets | Headline result |
|---|---|---|---|
| `etl_jobcards.py` | `data/Job_Record.xlsx` (Requested job + C-job) | `tx_jobcard`, `cost_job_summary` | 3,340 job cards · 0 dropped · 4 general-placeholder assets |
| `etl_stores.py` | `data/inventory.db` (storesdb SQLite) | `md_item`, `md_supplier`, `md_asset`, `md_battery`, `mv_stock_ledger` | 2,836 items · 301 suppliers · 4,077 movements · 1,413 pending price |
| `etl_labour.py` | `data/Daily_Work_Done.xlsx` | `md_employee`, `md_labour_rate`, `tx_job_progress`, `tx_job_labour` | 3,463 labour lines · LKR 7.00M · 308 rate-pending |
| `etl_lubricant.py` | `data/oilbook.db` (oilsystem SQLite) | `md_item(LUBRICANT)`, `md_asset`, `md_project`, `tx_lube_issue`, `inv_lube_monthly_balance` | 1,691 movements · reconciles 19/20 · 156 pending consumers |
| `job_costing.py` | all of the above | per-job cost roll-up (labour+material+recorded) | 412 costed jobs · 156 recomputed from labour |

## Running

```bash
pip install openpyxl
mkdir -p data   # place Job_Record.xlsx, Daily_Work_Done.xlsx, inventory.db, oilbook.db here
python3 migration/etl_stores.py     data/inventory.db out/
python3 migration/etl_jobcards.py   data/Job_Record.xlsx out/
python3 migration/etl_labour.py     data/Daily_Work_Done.xlsx out/
python3 migration/etl_lubricant.py  data/oilbook.db out/
python3 migration/job_costing.py    # writes jobs_costing.json
```

## Cross-source consolidation (verified)
- **Fleet:** 550 (job cards) + 769 (stores) + 639 (oil) → **1,339 unified assets** after dedup by
  normalized registration (overlaps confirm one fleet).
- **Items:** 2,716 (stores) + 21 (oil lube) → **2,730** (7 lube overlaps merged).

## Migration policy (applied by every ETL)
- **No-drop:** every source row loads — merged, linked, or flagged. Missing vehicle → general
  placeholder asset. Rate-less mechanic → `RATE_PENDING`. Unpriced receipt → `inv_pending_price`.
  Only a row with literally no key is a hard reject.
- **Idempotent:** keyed by source id / `import_hash` — re-runs upsert, never duplicate.
- **Reconciled:** the lubricant ledger is checked against the source's own running balance.

## Exception queues to clear before cutover (P0 gate — `PRODUCTION_READINESS.md`)
| Queue | Count | Resolution |
|---|---|---|
| Pending pricing (GRN) | 1,413 | Pricing officer enters unit prices → revalue |
| Lube meter missing | 1,515 | Backfill meter from asset/job or capture going forward |
| Lube consumer unresolved | 403 | Map raw consumer text → asset/project (`map_*_xref`) |
| Job reconciliation | 286 | Resolve vehicle-mismatch / job-no collisions |
| Labour rate-pending | 308 | Assign rates to new mechanics |
| Ledger recon mismatch | 1 | Investigate the one product whose balance differs |
| Hard rejects | 0 | — |
