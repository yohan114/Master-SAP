// Generate sql/schema.sqlite.sql from the canonical PostgreSQL schema (sql/schema.sql).
// The two schemas are kept in lock-step: edit schema.sql, then re-run this to refresh the
// SQLite variant. The translation is deliberately small — the app uses very little that
// differs between the engines:
//
//   * BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY  ->  INTEGER PRIMARY KEY AUTOINCREMENT
//     (SQLite's rowid alias; monotonic ids like Postgres IDENTITY)
//   * other BIGINT columns                             ->  INTEGER
//   * TIMESTAMPTZ                                       ->  TEXT (ISO-8601 strings)
//   * now()                                            ->  CURRENT_TIMESTAMP
//   * the 12 cross-reference ALTER TABLE ... ADD FOREIGN KEY statements are dropped
//     (SQLite can't ALTER-ADD a foreign key; those relations are app-maintained, exactly
//      as the inline FKs are — the SQLite engine runs with foreign_keys OFF)
//
// Everything else — inline REFERENCES, CHECK constraints, the STORED generated column,
// partial indexes, DEFAULT literals, ON CONFLICT, RETURNING, FILTER — is valid SQLite as-is.
//
//   node sql/gen-sqlite-schema.js
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

let out = src
  // drop Postgres-only CREATE EXTENSION lines (SQLite has no extensions; admin dedup falls back to JS)
  .replace(/CREATE EXTENSION[^;]*;\s*/gi, '')
  // drop the deferred cross-reference FKs (Section 13); each is one `ALTER TABLE … ;`
  .replace(/ALTER TABLE[\s\S]*?;\s*/g, '')
  // identity PKs -> SQLite autoincrement rowid alias (must run before the generic BIGINT swap)
  .replace(/BIGINT\s+GENERATED\s+ALWAYS\s+AS\s+IDENTITY\s+PRIMARY\s+KEY/gi, 'INTEGER PRIMARY KEY AUTOINCREMENT')
  // remaining BIGINT columns (FKs, measures) -> INTEGER
  .replace(/\bBIGINT\b/g, 'INTEGER')
  // Postgres timestamp type -> TEXT (we store ISO-8601 strings)
  .replace(/\bTIMESTAMPTZ\b/g, 'TEXT')
  // now() (in DEFAULTs) -> SQLite's UTC current timestamp
  .replace(/\bnow\(\)/gi, 'CURRENT_TIMESTAMP');

const header = `-- =====================================================================
-- UMMS — SQLite schema (GENERATED — do not edit by hand)
-- Source: sql/schema.sql  ·  Regenerate: node sql/gen-sqlite-schema.js
-- The app selects this variant when DB_ENGINE=sqlite (or SQLITE_DB is set).
-- =====================================================================

`;

const dst = path.join(__dirname, 'schema.sqlite.sql');
fs.writeFileSync(dst, header + out);

const tables = (out.match(/CREATE TABLE/gi) || []).length;
const indexes = (out.match(/CREATE (UNIQUE )?INDEX/gi) || []).length;
const alters = (out.match(/ALTER TABLE/gi) || []).length;
console.log(`Wrote ${path.relative(process.cwd(), dst)}: ${tables} tables, ${indexes} indexes, ${alters} ALTER TABLE (should be 0).`);
