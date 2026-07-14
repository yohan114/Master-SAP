// Row-level site enforcement for MUTATIONS (the write-side twin of scopeWhere on reads).
// Blocks a site-restricted user from updating/deleting/moving a row that belongs to another
// site by guessing its id. Admins and READ.ALL_SITES pass. Non-row mutations (bulk import,
// plain creates) pass — the new row gets the user's site at insert time.
const { get } = require('../db');
const { audit } = require('./audit');

// Row target from the URL: last numeric path segment -> table by prefix.
const PATH_TABLE = [
  [/^\/api\/items(\/|$)/, 'items'],
  [/^\/api\/receipts(\/|$)/, 'receipts'],
  [/^\/api\/issues(\/|$)/, 'issues'],
  [/^\/api\/batteries(\/|$)/, 'batteries'],
  [/^\/api\/transfers(\/|$)/, 'material_transfers'],
  [/^\/api\/general-items(\/|$)/, 'general_items'],
];
// Mutations that carry the target id in the BODY instead of the path.
const BODY_TARGET = {
  '/api/batteries/move': ['batteryId', 'batteries'],
  '/api/general-items/transaction': ['itemId', 'general_items'],
};

function targetRow(req) {
  const path = (req.baseUrl || '') + req.path;
  const body = BODY_TARGET[path];
  if (body) {
    const [key, table] = body;
    const id = Number(req.body && req.body[key]);
    return Number.isFinite(id) ? { table, id } : { table: null, id: null };
  }
  const m = path.match(/\/(\d+)(?=\/|$)/);
  if (!m) return { table: null, id: null };
  for (const [re, t] of PATH_TABLE) if (re.test(path)) return { table: t, id: Number(m[1]) };
  return { table: null, id: null };
}

// Middleware — run it AFTER authMiddleware (needs req.perms / req.sites).
function enforceSite(req, res, next) {
  if (!req.perms || req.perms.has('READ.ALL_SITES') || req.perms.has('ADMIN.ALL')) return next();
  const { table, id } = targetRow(req);
  if (!table || id == null) return next();          // create / bulk — site is stamped on insert
  let row;
  try { row = get(`SELECT site_id FROM ${table} WHERE id = ?`, [id]); } catch (_) { return next(); }
  if (!row) return next();                            // let the handler return its own 404
  if (!req.sites.has(row.site_id)) {
    audit('AUTHZ_SITE_DENY', { userId: req.user && req.user.id, entity: `${table}#${id}`,
      detail: { rowSite: row.site_id, userSites: [...req.sites] } });
    return res.status(403).json({ error: 'That record belongs to another site.' });
  }
  return next();
}

module.exports = { enforceSite };
