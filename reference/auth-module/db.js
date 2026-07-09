// Unified tiny DB wrapper. Prefers better-sqlite3 (if installed), else Node's built-in node:sqlite.
// Same pattern the legacy oil app uses — zero native build required to run.
const path = require('path');
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'auth.db');

let db, kind;
try {
  const Database = require('better-sqlite3');
  db = new Database(DB_FILE);
  kind = 'better-sqlite3';
} catch (_) {
  const { DatabaseSync } = require('node:sqlite');
  db = new DatabaseSync(DB_FILE);
  kind = 'node:sqlite';
}

const get  = (sql, params = []) => db.prepare(sql).get(...params);
const all  = (sql, params = []) => db.prepare(sql).all(...params);
const run  = (sql, params = []) => db.prepare(sql).run(...params);
const exec = (sql) => db.exec(sql);

module.exports = { db, kind, get, all, run, exec, DB_FILE };
