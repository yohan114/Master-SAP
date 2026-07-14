# Imported legacy data (UMMS)

This directory is a **permanent, committed snapshot of the historical operational data**
that was extracted and cleaned by the two migration jobs in `../migrations/`:

| Import | Source file | Migration script |
|--------|-------------|------------------|
| **002 — Workshop job records** | `Job_Record_Requested_and_Cjob.xlsx` (two sheets, 2023–2026) | `migrations/002-job-records/migrate-job-records.js` |
| **003 — Stores MRN / receipts** | `tracker_backup_20260712.json` | `migrations/003-tracker-mrn/migrate-tracker-backup.js` |

The raw source files themselves are **not** in git (they hold the same data in a rawer form and
are kept locally). This folder is the durable, openable copy of everything those imports produced —
**16,913 rows across 10 tables**.

> **Note on scope.** These are the migration **staging tables** (`wk_*` / `stg_*`). They hold the
> cleaned, matched legacy data but are deliberately kept separate from the app's *live* Workshop and
> Stores tables (`tx_jobcard`, `tx_mrn`, …) so the running system was never overwritten. See
> "Staging vs. live" below.

---

## What's here

```
imported-data/
├── db/
│   └── umms-imported-data.sqlite   ← the whole thing in one SQLite file (10 tables)
├── csv/                            ← one lossless CSV per table (exact table dump)
│   ├── wk_job_card.csv    wk_asset.csv   wk_site.csv   import_warnings.csv
│   └── stg_mrn.csv  stg_mrn_line.csv  stg_grn.csv  stg_mrn_item.csv  stg_mrn_asset.csv  stg_import_log.csv
├── reports/                        ← human-friendly, joined "read me first" views
│   ├── 01_job_records.csv          ← all job cards, ready for Excel
│   ├── 02_mrn_lines.csv            ← MRN lines with item + vehicle names filled in
│   ├── 03_mrn_receipts.csv         ← goods receipts with item + supplier names filled in
│   └── migration-report-mrn.csv    ← per-record log from the MRN import (what matched/flagged)
├── MANIFEST.md                     ← row counts + SHA-256 checksum of every file
└── README.md                       ← this file
```

`db/` + `csv/` are **the data** (complete and lossless). `reports/` is the same data pre-joined so a
non-technical reader can open it in Excel and understand it without writing SQL.

---

## How to open it

**Just want to read it in Excel / Google Sheets?**
Open anything in `reports/` (or `csv/`). They're UTF-8, comma-separated, first row = column headers.
Start with `reports/01_job_records.csv` and `reports/03_mrn_receipts.csv`.

**Want the whole queryable database?**
1. Install the free **DB Browser for SQLite** — <https://sqlitebrowser.org>
2. *File → Open Database →* `db/umms-imported-data.sqlite`
3. *Browse Data* tab → pick a table, or use *Execute SQL* to run queries, e.g.
   ```sql
   SELECT status, COUNT(*) FROM wk_job_card GROUP BY status;
   SELECT supplier_name, COUNT(*) FROM stg_grn GROUP BY supplier_name ORDER BY 2 DESC;
   ```

---

## Table dictionary

### Workshop (from the Excel job records)
| Table | Rows | What it is |
|-------|-----:|------------|
| `wk_job_card` | 3053 | One row per job card (natural key `job_card_no`, e.g. `2023/3/R/27`). Status is `OPEN`/`CLOSED`/`PENDING`/`CANCELLED`. `cost`, `hours`, `ref_no` come from the C-job sheet; `odometer_at_job` was extracted from the description/remarks. |
| `wk_asset` | 557 | Distinct vehicles/equipment. `asset_code` is the reg. no (e.g. `LO-5981`) or `EQP-<name>` for equipment. |
| `wk_site` | 114 | Distinct sites (normalised). `is_nonstandard=1` flags odd values (codes with digits/slashes, `H/O`, …). |
| `import_warnings` | 1095 | Data-quality flags raised during import (inverted/out-of-range/future dates, missing asset, extracted odometer, …). |

### Stores / MRN (from the tracker JSON)
| Table | Rows | What it is |
|-------|-----:|------------|
| `stg_mrn` | 1341 | One row per MRN number. `status` = `FULFILLED` / `PARTIAL` / `PENDING`. |
| `stg_mrn_line` | 3967 | One row per requested line item (JSON `id` is the key). Links a `stg_mrn` to an item and a vehicle/dept. |
| `stg_grn` | 3188 | One row per goods receipt. `unit_price` is `NULL` for the **1340 unpriced** receipts (`is_priced=0`); has `supplier_name`, `invoice_number`, `grn_number`. |
| `stg_mrn_item` | 2732 | Distinct items seen in the tracker. `matched_item_id` = the live `md_item` it matched (read-only), or `NULL`. |
| `stg_mrn_asset` | 779 | Distinct `vehicleMachinery` values, split into `kind`=`ASSET` (a vehicle) vs `DEPT` (a workshop dept). |
| `stg_import_log` | 87 | Records flagged during import — mostly the **87 rows that had no MRN number**. |

---

## Data-quality highlights (already computed for you)

- **Job cards:** `CLOSED` 2808 · `OPEN` 132 · `PENDING` 70 · `CANCELLED` 43. Date range 2023-02-02 → 2026-08-13.
- **MRNs:** `FULFILLED` 738 · `PARTIAL` 389 · `PENDING` 214. 87 source records had no MRN number (flagged, not dropped — see `stg_import_log`).
- **Receipts:** 1340 of 3188 are **unpriced** — they'll each need a unit price before they can be valued.
- Full per-record trail is in `reports/migration-report-mrn.csv` and the `import_warnings` table.

---

## Staging vs. live (important)

This is **historical reference data**, not live app state. It intentionally sits *outside* the app's
live tables so importing it never revalued real stock or corrupted the live approval workflow. Each
item/vehicle was matched to the live master **read-only** (`matched_item_id` / `matched_asset_id`)
so a later, deliberate reconciliation step *could* promote chosen rows into `tx_jobcard` / `tx_mrn` /
`md_item` / `md_asset`. That promotion has **not** been run. Ask if you want it built (note: the 1340
unpriced receipts need pricing first).

Checksums for every file are in [`MANIFEST.md`](./MANIFEST.md).
