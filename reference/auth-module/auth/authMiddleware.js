// Authentication: resolves the session cookie to a user and loads their permissions + sites.
const { get, all } = require('../db');

function authMiddleware(req, res, next) {
  const token = req.cookies && req.cookies.umms_sid;
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });

  const s = get('SELECT * FROM sessions WHERE token = ? AND expires_at > ?', [token, new Date().toISOString()]);
  if (!s) return res.status(401).json({ error: 'Session expired. Please sign in again.' });

  const user = get('SELECT * FROM sec_user WHERE id = ? AND is_active = 1', [s.user_id]);
  if (!user || user.is_locked) return res.status(401).json({ error: 'Account unavailable.' });

  req.user = user;
  req.perms = new Set(all(`
    SELECT p.permission_code AS c
    FROM sec_user_role ur
    JOIN sec_role_permission rp ON rp.role_id = ur.role_id
    JOIN sec_permission p       ON p.id = rp.permission_id
    WHERE ur.user_id = ?`, [user.id]).map((row) => row.c));
  req.sites = new Set(all('SELECT location_id AS s FROM sec_user_site WHERE user_id = ?', [user.id]).map((row) => row.s));
  next();
}

module.exports = { authMiddleware };
