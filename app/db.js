// PostgreSQL data layer. Connection comes from standard PG* env vars
// (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE) — no secrets in code.
const { Pool } = require('pg');

const pool = new Pool({ max: 10, idleTimeoutMillis: 30000 });

// Parameterized query — never string-concatenate user input.
async function q(text, params = []) {
  const r = await pool.query(text, params);
  return r.rows;
}
// First row or null.
async function one(text, params = []) {
  const rows = await q(text, params);
  return rows[0] || null;
}
// Run fn inside a transaction with a dedicated client; constraints deferred so the
// heavy FK graph (created_by self-refs, etc.) validates at commit, not per-statement.
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

module.exports = { pool, q, one, tx };
