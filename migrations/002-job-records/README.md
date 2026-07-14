# 002 — Legacy workshop job-record import

Imports the historical job records from **`Job_Record_Requested_and_Cjob.xlsx`** (two sheets,
2023–2026, ~3,053 unique jobs) into a self-contained **`wk_*` staging schema**.

## Run it

```bash
# put the workbook in ./source/ (it is git-ignored — see the data-safety note below)
cd app && npm install            # nothing new to install; the reader is dependency-free

# SQLite (local)
export DB_ENGINE=sqlite SQLITE_DB=./umms.sqlite
JOBS_XLSX=../migrations/002-job-records/source/Job_Record_Requested_and_Cjob.xlsx \
  node ../migrations/002-job-records/migrate-job-records.js

# PostgreSQL
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGDATABASE=umms
JOBS_XLSX=/path/to/Job_Record_Requested_and_Cjob.xlsx \
  node ../migrations/002-job-records/migrate-job-records.js
```

The script creates the schema itself (idempotent), so you don't have to run `002-job-cards-seed.sql`
by hand — but it's provided if you prefer to pre-create the tables (`psql -d umms -f 002-job-cards-seed.sql`).
Re-running is safe: job cards upsert on `job_card_no`, and warnings are rebuilt each run.

## What it produces

`wk_job_card` (natural key `job_card_no`), plus `wk_asset` / `wk_site` lookups and an `import_warnings`
log. Validated end-to-end on the real file:

```
Total job cards loaded : 3053
By status              : CLOSED=2808  OPEN=132  PENDING=70  CANCELLED=43
Sites: 114   Assets: 557
Warnings: NONSTANDARD_SITE, ODOMETER_EXTRACTED, EQUIPMENT_ASSET, DATE_INVERTED,
          MISSING_ASSET, FUTURE_DATE, DATE_OUT_OF_RANGE
Date range: 2023-02-02 → 2026-08-13
```

## Decisions & deviations from the original spec (why)

This landed differently from the literal request because the request targeted tables/columns that
don't exist in UMMS, and because sheet 2 isn't shaped like sheet 1. Every change is deliberate:

- **Staging tables, not the live Workshop.** The spec's `wk_job_card` / `md_site` don't exist; the live
  Workshop is `tx_jobcard` (+ `md_asset` / `md_location`), which is built around the live TM/OM approval
  workflow with strict NOT-NULL/CHECK constraints. Loading 3k historical rows straight into it would
  corrupt live data and can't cleanly represent `OPEN`/`PENDING`. So the import lands in **self-contained
  `wk_*` staging tables** (reversible — just `DROP` them). A reconciliation pass can later promote chosen
  rows into `tx_jobcard`. Ask if you want that built.
- **Sheet 2 ("C-job") has a DIFFERENT column layout** — `Job no · Ref. · Vehicle · Repair Description ·
  Start · End · Hrs · Cost · Site · Remarks`. The spec said "apply the same mapping"; doing so would
  have mis-read all 510 rows. It's mapped per its real layout, and its **Hrs / Cost / Ref.** are captured
  (268 jobs get a real completion cost). On overlap (468 job numbers), C-job wins and enriches.
- **`job_type` (MJ/MR) is empty** across all 3,028 source rows, so it imports as `NULL` (the MAJOR/MINOR
  mapping has nothing to map).
- **Assets → `asset_code`** (there's no `asset_code` column on the live `md_asset`; its natural key is
  `asset_no`). Dashless equipment names get an `EQP-` prefix and `is_equipment=true`, per spec.
- **Sites** are case/spelling-deduped and title-cased; non-standard ones (codes with digits/slashes,
  `H/O`, `solution`, …) are flagged `NONSTANDARD_SITE`.
- **Data-quality flags** in `import_warnings`: inverted dates, out-of-range dates (a 1908 typo), future
  dates, missing assets, extracted odometer readings.
- **Engine-agnostic:** writes through the app's `db.js`, so the same script runs on PostgreSQL or SQLite.

## ⚠️ Data safety

`Job_Record_Requested_and_Cjob.xlsx` is **real operational data** (vehicle registrations, sites, costs),
so it is **not committed** — `./source/` is git-ignored. Keep the workbook local and run the import
against your own database. Only the code (script, reader, schema) lives in git.
