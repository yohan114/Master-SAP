// Records who + when + before/after for every /api mutation (create/update/delete),
// appending one row to audit_log. Table-agnostic: it derives the table + id from the
// path, snapshots the row before the handler runs, and re-reads it after — so price/cost
// edits and deletes are never silent. Mount once, right after the /api auth guard.
const { get } = require('../db');
const { audit } = require('./audit');

// URL prefix -> physical table, used to snapshot the affected row.
const PATH_TABLE = [
  [/^\/api\/items(\/|$)/, 'items'],
  [/^\/api\/receipts(\/|$)/, 'receipts'],
  [/^\/api\/issues(\/|$)/, 'issues'],
  [/^\/api\/batteries(\/|$)/, 'batteries'],
  [/^\/api\/transfers(\/|$)/, 'material_transfers'],
  [/^\/api\/general-items(\/|$)/, 'general_items'],
];
const tableFor = (p) => { for (const [re, t] of PATH_TABLE) if (re.test(p)) return t; return null; };

// Never write credentials/secrets into the trail, even if a route ever receives them.
const REDACT = /pass(word)?|token|secret|otp|mfa/i;
function sanitize(body) {
  if (!body || typeof body !== 'object') return body ?? null;
  const out = {};
  for (const k of Object.keys(body)) out[k] = REDACT.test(k) ? '[redacted]' : body[k];
  return out;
}
// Keys whose value changed between the before/after snapshots (ignoring updatedAt noise).
function changedKeys(before, after) {
  if (!before || !after) return null;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed = [];
  for (const k of keys) {
    if (k === 'updatedAt') continue;
    if (before[k] !== after[k]) changed.push(k);
  }
  return changed;
}

function auditChange(req, res, next) {
  const m = req.method;
  if (m !== 'POST' && m !== 'PUT' && m !== 'PATCH' && m !== 'DELETE') return next();

  const path = (req.baseUrl || '') + req.path;
  const table = tableFor(path);
  const idMatch = path.match(/\/(\d+)(?=\/|$)/);          // trailing numeric id, if any
  const id = idMatch ? Number(idMatch[1]) : null;

  // Before-image for row updates/deletes (the row still exists at this point).
  let before = null;
  if (table && id != null && m !== 'POST') {
    try { before = get(`SELECT * FROM ${table} WHERE id = ?`, [id]); } catch (_) {}
  }

  // Capture the JSON the handler sends back (gives us the new id on create).
  const origJson = res.json.bind(res);
  let responseBody;
  res.json = (b) => { responseBody = b; return origJson(b); };

  res.on('finish', () => {
    const ok = res.statusCode < 400;
    let after = null;
    if (ok && table && m !== 'DELETE') {
      const rowId = id != null ? id : (responseBody && responseBody.id);
      if (rowId != null) { try { after = get(`SELECT * FROM ${table} WHERE id = ?`, [rowId]); } catch (_) {} }
    }
    const detail = {
      method: m, path, status: res.statusCode, ok,
      ip: req.ip || (req.socket && req.socket.remoteAddress) || null,
      reason: (req.body && req.body.reason) || null,   // reversals/adjustments should pass a reason
      request: sanitize(req.body),
      before, after,
      changed: changedKeys(before, after),
    };
    const rowRef = table ? `${table}${id != null ? '#' + id : (after && after.id ? '#' + after.id : '')}` : path;
    audit(`${m} ${path}${ok ? '' : ' [denied]'}`, { userId: req.user && req.user.id, entity: rowRef, detail });
  });

  next();
}

module.exports = { auditChange };
