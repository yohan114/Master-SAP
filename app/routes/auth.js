// Public auth: login (issue session cookie) + logout. Every login attempt (success or failure) is
// written to sec_audit_log; repeated failures trip a temporary account lockout.
const express = require('express');
const { one, q } = require('../db');
const { verifyPassword } = require('../auth/password');
const { createSession, destroySession } = require('../auth/mw');

const router = express.Router();

// Brute-force guard: LOCK_THRESHOLD failures within LOCK_WINDOW_MIN → locked for LOCK_DURATION_MIN.
const LOCK_THRESHOLD = 5, LOCK_WINDOW_MIN = 10, LOCK_DURATION_MIN = 15;

async function audit(userId, username, ip, ua, success) {
  await q('INSERT INTO sec_audit_log(user_id, username, ip_address, user_agent, success, attempted_at) VALUES($1,$2,$3,$4,$5,$6)',
    [userId || null, (username || '').slice(0, 60) || null, (ip || '').slice(0, 45) || null, (ua || '').slice(0, 300) || null, success, new Date().toISOString()]);
}

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || null;
    const ua = req.headers['user-agent'] || '';
    const now = new Date();
    const user = await one('SELECT user_id, password_hash, is_locked, locked_until, must_change_password FROM sec_user WHERE username=$1 AND is_active', [username]);

    // Already inside a temporary lockout window → refuse before checking the password.
    if (user && user.locked_until && new Date(user.locked_until) > now) {
      await audit(user.user_id, username, ip, ua, false);
      return res.status(429).json({ error: 'Account temporarily locked. Try again later.' });
    }

    const ok = !!user && !user.is_locked && verifyPassword(user.password_hash, password || '');
    await audit(user ? user.user_id : null, username, ip, ua, ok);

    if (!ok) {
      // Count this user's recent failures; the one that reaches the threshold arms the lockout.
      if (user) {
        const cutoff = new Date(now.getTime() - LOCK_WINDOW_MIN * 60000).toISOString();
        const fails = Number((await one('SELECT COUNT(*) AS n FROM sec_audit_log WHERE user_id=$1 AND success=$2 AND attempted_at > $3', [user.user_id, false, cutoff])).n);
        if (fails >= LOCK_THRESHOLD) {
          const until = new Date(now.getTime() + LOCK_DURATION_MIN * 60000).toISOString();
          await q('UPDATE sec_user SET locked_until=$1, updated_at=now() WHERE user_id=$2', [until, user.user_id]);
          return res.status(429).json({ error: 'Account temporarily locked. Try again later.' });
        }
      }
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    // Success: clear any lockout, stamp the login, issue the session.
    await q('UPDATE sec_user SET last_login_at=now(), locked_until=NULL WHERE user_id=$1', [user.user_id]);
    const { token, maxAge } = await createSession(user.user_id);
    res.cookie('umms_sid', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge });
    res.json({ user: { user_id: user.user_id, username }, must_change_password: !!user.must_change_password });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/logout', async (req, res) => {
  await destroySession(req.cookies && req.cookies.umms_sid);
  res.clearCookie('umms_sid').json({ ok: true });
});

module.exports = router;
