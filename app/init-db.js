// First-boot database initializer for the container. Loads sql/schema.sql if the
// schema isn't there yet; otherwise no-ops. Seeding is done separately (seed.js is
// idempotent). Connection comes from PG* env vars.
const fs = require('fs');
const path = require('path');
const { pool, one } = require('./db');

(async () => {
  const present = await one("SELECT 1 AS ok FROM information_schema.tables WHERE table_name='md_item' LIMIT 1");
  if (present) { console.log('init-db: schema already present — skipping load.'); process.exit(0); }
  const schemaPath = process.env.SCHEMA_SQL || path.join(__dirname, '..', 'sql', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  console.log(`init-db: loading schema from ${schemaPath} …`);
  await pool.query(sql);                 // simple-query protocol runs the whole multi-statement file
  console.log('init-db: schema loaded (fresh).');
  process.exit(10);                      // exit 10 = fresh DB -> entrypoint should seed (never re-seed an existing DB)
})().catch((e) => { console.error('init-db failed:', e.message); process.exit(1); });
