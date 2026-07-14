#!/usr/bin/env node
// =====================================================================
// Patch 001 — MRN traceability (Commit 1)
//
// Brings an ALREADY-DEPLOYED database up to the Commit-1 schema WITHOUT a
// destructive reload. Fresh installs get all of this from sql/schema.sql
// (+ generated schema.sqlite.sql) via init-db.js and do NOT need this patch.
//
// Idempotent + engine-aware (runs through the app's db.js, so it works on
// PostgreSQL or SQLite). Re-running is a safe no-op. It only ADDS:
//   1. txl_issue.mrn_line_id            (nullable; FK -> txl_mrn on Postgres)
//   2. hist_mrn_status                  (MRN status/action audit table)
//   3. MRN traceability + search indexes
// It never drops, renames, retypes, or writes business data.
//
// Run:  node sql/patches/001-mrn-traceability.js
//   PostgreSQL: export PGHOST=... PGDATABASE=umms ...   (or DB_ENGINE=postgres)
//   SQLite:     export DB_ENGINE=sqlite SQLITE_DB=./app/umms.sqlite
// =====================================================================
const { ENGINE, q, one } = require('../../app/db');

async function hasColumn(table, col) {
  if (ENGINE === 'sqlite') {
    const rows = await q(`PRAGMA table_info(${table})`);   // table name is a constant, not user input
    return rows.some((r) => r.name === col);
  }
  return !!(await one(
    'SELECT 1 AS ok FROM information_schema.columns WHERE table_name=$1 AND column_name=$2', [table, col]));
}

// Every index the canonical schema defines for MRN traceability, as IF NOT EXISTS
// so a patched DB ends up identical to a fresh one. Kept in sync with sql/schema.sql.
const INDEXES = [
  'CREATE INDEX IF NOT EXISTS ix_hist_mrn_status_mrn ON hist_mrn_status(mrn_id, mrn_status_hist_id)',
  'CREATE INDEX IF NOT EXISTS ix_tx_mrn_site_date   ON tx_mrn (site_id, mrn_date)',
  'CREATE INDEX IF NOT EXISTS ix_tx_mrn_status       ON tx_mrn (doc_status)',
  'CREATE INDEX IF NOT EXISTS ix_tx_mrn_location     ON tx_mrn (location_id)',
  'CREATE INDEX IF NOT EXISTS ix_tx_mrn_asset        ON tx_mrn (asset_id)   WHERE asset_id IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS ix_tx_mrn_jobcard      ON tx_mrn (jobcard_id) WHERE jobcard_id IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS ix_txl_mrn_item        ON txl_mrn (item_id)',
  'CREATE INDEX IF NOT EXISTS ix_txl_mrn_status      ON txl_mrn (line_status)',
  'CREATE INDEX IF NOT EXISTS ix_tx_issue_mrn        ON tx_issue (mrn_id)   WHERE mrn_id IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS ix_txl_issue_mrn_line  ON txl_issue (mrn_line_id) WHERE mrn_line_id IS NOT NULL',
];

(async () => {
  const steps = [];

  // 1. txl_issue.mrn_line_id (nullable) — add only if missing.
  let columnAdded = false;
  if (await hasColumn('txl_issue', 'mrn_line_id')) {
    steps.push('skip  txl_issue.mrn_line_id (already present)');
  } else {
    await q(`ALTER TABLE txl_issue ADD COLUMN mrn_line_id ${ENGINE === 'sqlite' ? 'INTEGER' : 'BIGINT'}`);
    columnAdded = true;
    steps.push('ADD   txl_issue.mrn_line_id');
  }

  // 2. FK on Postgres — only when WE added the column (a fresh DB already carries the inline FK,
  //    so this never double-adds). SQLite runs foreign_keys=OFF and can't ALTER ADD FOREIGN KEY.
  if (ENGINE !== 'sqlite' && columnAdded) {
    await q('ALTER TABLE txl_issue ADD CONSTRAINT fk_txl_issue_mrn_line FOREIGN KEY (mrn_line_id) REFERENCES txl_mrn(mrn_line_id)');
    steps.push('ADD   FK fk_txl_issue_mrn_line -> txl_mrn(mrn_line_id)');
  }

  // 3. hist_mrn_status — engine-aware identity PK; everything else is translated by db.js.
  const pk = ENGINE === 'sqlite' ? 'INTEGER PRIMARY KEY AUTOINCREMENT' : 'BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY';
  await q(`CREATE TABLE IF NOT EXISTS hist_mrn_status (
    mrn_status_hist_id ${pk},
    mrn_id       BIGINT NOT NULL REFERENCES tx_mrn(mrn_id),
    from_status  VARCHAR(15),
    to_status    VARCHAR(15) NOT NULL,
    action       VARCHAR(20) NOT NULL,
    note         VARCHAR(300),
    changed_by   BIGINT      NOT NULL REFERENCES sec_user(user_id),
    changed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    site_id      BIGINT      NOT NULL REFERENCES md_location(location_id)
  )`);
  steps.push('ENSURE hist_mrn_status');

  // 4. Indexes (idempotent).
  for (const sql of INDEXES) await q(sql);
  steps.push(`ENSURE ${INDEXES.length} indexes`);

  console.log(`patch 001-mrn-traceability (${ENGINE}):`);
  for (const s of steps) console.log('  ' + s);
  console.log('done.');
  process.exit(0);
})().catch((e) => { console.error('patch 001 failed:', e.message); process.exit(1); });
