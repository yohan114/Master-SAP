# SQL patches

Small, **idempotent, non-destructive** upgrades for databases that were created from an
**older** `sql/schema.sql`. Fresh installs never need these — `init-db.js` loads the current
schema (Postgres: `sql/schema.sql`; SQLite: the generated `sql/schema.sqlite.sql`) which already
contains everything a patch would add.

Each patch runs through the app's `db.js`, so the **same file works on PostgreSQL and SQLite**, and
re-running is a safe no-op.

| Patch | Adds | Destructive? |
|-------|------|--------------|
| `001-mrn-traceability.js` | `txl_issue.mrn_line_id` (nullable; FK → `txl_mrn` on Postgres), `hist_mrn_status` table, MRN traceability + search indexes | No — only additive |

## Run

```bash
# PostgreSQL
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGDATABASE=umms   # (DB_ENGINE defaults to postgres)
node sql/patches/001-mrn-traceability.js

# SQLite
export DB_ENGINE=sqlite SQLITE_DB=./app/umms.sqlite
node sql/patches/001-mrn-traceability.js
```

The patch prints each step (`ADD` / `ENSURE` / `skip`) and exits `0`. Take a backup first as a
matter of habit, though the patch only ever adds a nullable column, a new table, and indexes.
