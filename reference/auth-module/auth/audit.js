// Append-only audit trail helper (paired with every mutating/security-relevant action).
const { run } = require('../db');

function audit(action, meta = {}) {
  try {
    run('INSERT INTO audit_log(action, user_id, entity, detail, at) VALUES(?,?,?,?,?)', [
      action,
      meta.userId ?? null,
      meta.entity ?? null,
      JSON.stringify(meta.detail ?? null),
      new Date().toISOString(),
    ]);
  } catch (_) { /* never let auditing break the request */ }
}

module.exports = { audit };
