// Public auth: login (issue session cookie) + logout.
const express = require('express');
const { one, q } = require('../db');
const { verifyPassword } = require('../auth/password');
const { createSession, destroySession } = require('../auth/mw');

const router = express.Router();

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const user = await one('SELECT user_id, password_hash, is_locked FROM sec_user WHERE username=$1 AND is_active', [username]);
    const ok = !!user && !user.is_locked && verifyPassword(user.password_hash, password || '');
    if (!ok) return res.status(401).json({ error: 'Invalid username or password.' });
    const { token, maxAge } = await createSession(user.user_id);
    res.cookie('umms_sid', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge });
    res.json({ user: { user_id: user.user_id, username } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/logout', async (req, res) => {
  await destroySession(req.cookies && req.cookies.umms_sid);
  res.clearCookie('umms_sid').json({ ok: true });
});

module.exports = router;
