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

module.exports = { requirePerm, siteScope };
