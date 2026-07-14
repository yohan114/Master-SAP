// Authorization: permission gate + row-level site scoping.
const { audit } = require('./audit');

// Route guard: require a specific permission_code (admins with ADMIN.ALL pass everything).
const requirePerm = (code) => (req, res, next) => {
  if (req.perms.has(code) || req.perms.has('ADMIN.ALL')) return next();
  audit('AUTHZ_DENY', { userId: req.user.id, entity: req.path, detail: { need: code } });
  return res.status(403).json({ error: 'You do not have permission for this action.' });
};

// Row-level scope: append a site filter unless the user is all-site.
// Returns { clause, params } to splice into a WHERE.
function siteScope(req, params = []) {
  if (req.perms.has('READ.ALL_SITES') || req.perms.has('ADMIN.ALL')) return { clause: '', params };
  const sites = [...req.sites];
  if (!sites.length) return { clause: ' AND 1=0', params }; // no site assigned -> see nothing
  return { clause: ` AND site_id IN (${sites.map(() => '?').join(',')})`, params: [...params, ...sites] };
}

// Row-level scope as a BARE boolean condition, for routes that build a `where[]`
// array and join it into a WHERE. Returns { cond, params }:
//   cond === ''       -> all-site user, no restriction (push nothing)
//   cond === '1=0'    -> authenticated but no site assigned -> sees nothing
//   cond === '<a>.site_id IN (?,?)' -> restrict to the user's assigned sites
// `alias` is the table alias in the query (e.g. 'i' -> 'i.site_id'); omit for a bare column.
function scopeWhere(req, alias) {
  const col = alias ? `${alias}.site_id` : 'site_id';
  if (!req.perms || req.perms.has('READ.ALL_SITES') || req.perms.has('ADMIN.ALL')) return { cond: '', params: [] };
  const sites = [...(req.sites || [])];
  if (!sites.length) return { cond: '1=0', params: [] };
  return { cond: `${col} IN (${sites.map(() => '?').join(',')})`, params: sites };
}

module.exports = { requirePerm, siteScope, scopeWhere };
