// Authentication + authorization for the UMMS app.
// Sessions live in an app-owned table (app_session) created on boot. A request's
// cookie -> user + permission set + assigned site set.
const crypto = require('crypto');
const { q, one } = require('../db');

const SESSION_MS = 8 * 60 * 60 * 1000;

async function ensureSessionTable() {
  await q(`CREATE TABLE IF NOT EXISTS app_session (
    token TEXT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES sec_user(user_id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL)`);
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_MS).toISOString();
  await q('INSERT INTO app_session(token, user_id, expires_at) VALUES($1,$2,$3)', [token, userId, expires]);
  return { token, maxAge: SESSION_MS };
}
async function destroySession(token) {
  if (token) await q('DELETE FROM app_session WHERE token=$1', [token]);
}

// Resolve the cookie to req.user / req.perms / req.sites. 401 if no valid session.
async function authMiddleware(req, res, next) {
  try {
    const token = req.cookies && req.cookies.umms_sid;
    if (!token) return res.status(401).json({ error: 'Not authenticated.' });
    const s = await one('SELECT user_id FROM app_session WHERE token=$1 AND expires_at > now()', [token]);
    if (!s) return res.status(401).json({ error: 'Session expired.' });
    const user = await one('SELECT user_id, username, full_name, must_change_password FROM sec_user WHERE user_id=$1 AND is_active AND NOT is_locked', [s.user_id]);
    if (!user) return res.status(401).json({ error: 'Account unavailable.' });
    req.user = user;
    req.perms = new Set((await q(`
      SELECT p.permission_code AS c
      FROM sec_user_role ur
      JOIN sec_role_permission rp ON rp.role_id = ur.role_id
      JOIN sec_permission p ON p.permission_id = rp.permission_id
      WHERE ur.user_id = $1`, [user.user_id])).map((r) => r.c));
    req.sites = new Set((await q('SELECT site_id FROM sec_user_site WHERE user_id=$1', [user.user_id])).map((r) => r.site_id));
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// Require a permission_code (ADMIN.ALL passes everything).
const requirePerm = (code) => (req, res, next) => {
  if (req.perms.has(code) || req.perms.has('ADMIN.ALL')) return next();
  return res.status(403).json({ error: `Missing permission: ${code}` });
};

// Row-level site scope condition for a query, e.g. scopeSql(req,'jc',3) ->
// { sql: ' AND jc.site_id IN ($3,$4)', params:[...sites] } or empty for all-site users.
// Emits one placeholder per site (an IN-list) so it runs unchanged on Postgres and SQLite;
// site params are always appended last by callers.
function scopeSql(req, alias, startIdx) {
  const col = alias ? `${alias}.site_id` : 'site_id';
  if (req.perms.has('READ.ALL_SITES') || req.perms.has('ADMIN.ALL')) return { sql: '', params: [] };
  const sites = [...(req.sites || [])];
  if (!sites.length) return { sql: ' AND 1=0', params: [] };
  const ph = sites.map((_, i) => `$${startIdx + i}`).join(',');
  return { sql: ` AND ${col} IN (${ph})`, params: sites };
}

module.exports = { ensureSessionTable, createSession, destroySession, authMiddleware, requirePerm, scopeSql, SESSION_MS };
