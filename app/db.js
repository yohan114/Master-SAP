// Data layer for the UMMS app. Two engines, chosen once at boot:
//   * PostgreSQL (default)                        — node-postgres, standard PG* env vars.
//   * SQLite  (DB_ENGINE=sqlite, or SQLITE_DB set) — node:sqlite, one local file.
// The rest of the app is written against one small async interface (q / one / tx / exec),
// so no module knows or cares which engine is live. No secrets in code — connection details
// come from the environment.
const path = require('path');

const ENGINE = (process.env.DB_ENGINE || (process.env.SQLITE_DB ? 'sqlite' : 'postgres')).toLowerCase();

// ---------------------------------------------------------------------------
// PostgreSQL engine
// ---------------------------------------------------------------------------
function makePostgres() {
  const { Pool } = require('pg');
  const pool = new Pool({ max: 10, idleTimeoutMillis: 30000 });

  // Parameterized query — never string-concatenate user input.
  async function q(text, params = []) {
    const r = await pool.query(text, params);
    return r.rows;
  }
  async function one(text, params = []) { return (await q(text, params))[0] || null; }
  // Transaction on a dedicated client; constraints deferred so the heavy FK graph
  // (created_by self-refs, etc.) validates at commit, not per-statement.
  async function tx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET CONSTRAINTS ALL DEFERRED');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  const exec = (sql) => pool.query(sql).then(() => {});   // whole multi-statement file
  const end = () => pool.end();
  return { pool, q, one, tx, exec, end };
}

// ---------------------------------------------------------------------------
// SQLite engine (node:sqlite — synchronous, one shared connection)
// ---------------------------------------------------------------------------
function makeSqlite() {
  const { DatabaseSync } = require('node:sqlite');
  const file = process.env.SQLITE_DB || path.join(__dirname, 'umms.sqlite');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');   // concurrent readers alongside a writer
  db.exec('PRAGMA busy_timeout = 5000');  // wait, don't error, on a briefly-locked db
  db.exec('PRAGMA foreign_keys = OFF');   // FKs are app-maintained (as on the ALTER-added PG refs)

  // Translate the few Postgres-isms the app uses into their SQLite spelling.
  const coerce = (v) =>
    v === true ? 1 : v === false ? 0 : v === undefined ? null
      : v instanceof Date ? v.toISOString() : v;
  function translate(text, params) {
    const sql = text
      .replace(/\$(\d+)/g, '?$1')              // $N -> ?N (node:sqlite binds by index, so reuse works)
      .replace(/\bnow\(\)/gi, 'CURRENT_TIMESTAMP')
      .replace(/\bBOOL_OR\s*\(/gi, 'MAX(')     // no BOOL_OR; booleans are 0/1 so MAX == logical OR
      .replace(/\bTIMESTAMPTZ\b/gi, 'TEXT');   // for DDL issued at runtime (session/counter tables)
    return { sql, bind: (params || []).map(coerce) };
  }
  const returnsRows = (sql) => /^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);

  async function q(text, params = []) {
    const { sql, bind } = translate(text, params);
    const stmt = db.prepare(sql);
    if (returnsRows(sql)) return stmt.all(...bind);
    stmt.run(...bind);
    return [];
  }
  async function one(text, params = []) { return (await q(text, params))[0] || null; }

  // node:sqlite is synchronous, so a transaction is just BEGIN … COMMIT on the one
  // connection. We serialize transactions through a promise chain so two never overlap
  // even if a callback yields — the app's tx callbacks only ever do DB work (microtask
  // awaits), so a running tx completes before any other request is serviced.
  let chain = Promise.resolve();
  function tx(fn) {
    const run = async () => {
      db.exec('BEGIN');
      try {
        const client = { query: async (t, p = []) => ({ rows: await q(t, p) }) };
        const out = await fn(client);
        db.exec('COMMIT');
        return out;
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw e;
      }
    };
    const p = chain.then(run, run);   // wait for the previous tx to settle, then run
    chain = p.catch(() => {});        // a failed tx must not poison the chain
    return p;
  }

  const exec = (sql) => { db.exec(sql); return Promise.resolve(); };
  const end = () => { db.close(); return Promise.resolve(); };
  // Minimal pool shim so code that pokes pool.query (e.g. the container healthcheck) still works.
  const pool = { query: async (t, p = []) => ({ rows: await q(t, p) }) };
  return { pool, q, one, tx, exec, end };
}

const impl = ENGINE === 'sqlite' ? makeSqlite() : makePostgres();

module.exports = { ENGINE, ...impl };
