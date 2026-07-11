// First-boot database initializer. Loads the schema if it isn't there yet; otherwise
// no-ops. Works on either engine (Postgres -> sql/schema.sql, SQLite -> sql/schema.sqlite.sql).
// Seeding is done separately (seed.js is idempotent). Connection comes from the environment.
const fs = require('fs');
const path = require('path');
const { ENGINE, exec, one } = require('./db');

(async () => {
  const check = ENGINE === 'sqlite'
    ? "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='md_item' LIMIT 1"
    : "SELECT 1 AS ok FROM information_schema.tables WHERE table_name='md_item' LIMIT 1";
  const present = await one(check);
  if (present) { console.log('init-db: schema already present — skipping load.'); process.exit(0); }

  const file = ENGINE === 'sqlite' ? 'schema.sqlite.sql' : 'schema.sql';
  const schemaPath = process.env.SCHEMA_SQL || path.join(__dirname, '..', 'sql', file);
  const sql = fs.readFileSync(schemaPath, 'utf8');
  console.log(`init-db: loading ${ENGINE} schema from ${schemaPath} …`);
  await exec(sql);                        // runs the whole multi-statement file
  console.log('init-db: schema loaded (fresh).');
  process.exit(10);                      // exit 10 = fresh DB -> entrypoint should seed (never re-seed an existing DB)
})().catch((e) => { console.error('init-db failed:', e.message); process.exit(1); });
