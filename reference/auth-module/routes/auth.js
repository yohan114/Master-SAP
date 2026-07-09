// Public auth routes: login (rate-limited + lockout) and logout. No secrets in the URL.
const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { get, run } = require('../db');
const { verifyPassword } = require('../auth/password');
const { verifyTotp } = require('../auth/totp');
const { audit } = require('../auth/audit');

const router = express.Router();
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
const MAX_FAIL = 5;
const SESSION_MS = 8 * 60 * 60 * 1000;

router.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  const user = get('SELECT * FROM sec_user WHERE username = ? AND is_active = 1', [username]);
  const ok = !!user && !user.is_locked && (await verifyPassword(user.password_hash, password || ''));

  if (!ok) {
    if (user && !user.is_locked) {
      const fails = (user.failed_count || 0) + 1;
      run('UPDATE sec_user SET failed_count = ?, is_locked = ? WHERE id = ?', [fails, fails >= MAX_FAIL ? 1 : 0, user.id]);
    }
    audit('LOGIN_FAIL', { detail: { username } });
    return res.status(401).json({ error: 'Invalid username or password.' }); // do not reveal which
  }

  // Second factor (required for MFA-enabled accounts, e.g. admin / finance)
  if (user.mfa_enabled) {
    const { token: otp } = req.body || {};
    if (!verifyTotp(user.mfa_secret, otp)) {
      audit('LOGIN_MFA_FAIL', { userId: user.id });
      return res.status(401).json({ error: 'Authenticator code required or invalid.', mfa: true });
    }
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_MS).toISOString();
  run('INSERT INTO sessions(token, user_id, expires_at) VALUES(?,?,?)', [token, user.id, expires]);
  run('UPDATE sec_user SET failed_count = 0, last_login_at = ? WHERE id = ?', [new Date().toISOString(), user.id]);
  res.cookie('umms_sid', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production', // TLS-only in prod; allow http in local dev
    sameSite: 'lax',
    maxAge: SESSION_MS,
  });
  audit('LOGIN_OK', { userId: user.id });
  res.json({ user: { id: user.id, username: user.username, full_name: user.full_name } });
});

router.post('/logout', (req, res) => {
  const t = req.cookies && req.cookies.umms_sid;
  if (t) run('DELETE FROM sessions WHERE token = ?', [t]);
  res.clearCookie('umms_sid').json({ ok: true });
});

module.exports = router;
