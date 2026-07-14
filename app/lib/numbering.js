// Document numbering per the design contract: TYPE-SITE-YY-NNNNNN (atomic via a counter row).
const { q } = require('../db');

async function ensureCounterTable() {
  await q(`CREATE TABLE IF NOT EXISTS app_doc_counter (
    doc_type  VARCHAR(10) NOT NULL,
    site_code CHAR(3)     NOT NULL,
    yy        SMALLINT    NOT NULL,
    last_no   INTEGER     NOT NULL DEFAULT 0,
    PRIMARY KEY (doc_type, site_code, yy))`);
}

// Returns the next formatted number, e.g. JOB-HQ-26-000001. `client` optional (uses pool if absent).
async function nextNo(docType, siteCode, dateISO, client) {
  const yy = Number(String(dateISO || new Date().toISOString()).slice(2, 4));
  const runner = client ? (t, p) => client.query(t, p).then((r) => r.rows) : q;
  const rows = await runner(
    `INSERT INTO app_doc_counter(doc_type, site_code, yy, last_no) VALUES($1,$2,$3,1)
     ON CONFLICT (doc_type, site_code, yy) DO UPDATE SET last_no = app_doc_counter.last_no + 1
     RETURNING last_no`,
    [docType, siteCode, yy]
  );
  const n = rows[0].last_no;
  return `${docType}-${siteCode}-${String(yy).padStart(2, '0')}-${String(n).padStart(6, '0')}`;
}

module.exports = { ensureCounterTable, nextNo };
