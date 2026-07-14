// Authenticated self-service account routes (mounted under /api, so a valid session is required).
// change-password: verify the current password, enforce the complexity policy, rotate the hash, and
// clear the must_change_password flag.
const express = require('express');
const { one, q } = require('../db');
const { hashPassword, verifyPassword } = require('../auth/password');

const router = express.Router();

// Policy: ≥10 chars, at least one uppercase, one digit, one special character. Returns an error
// message, or null when the password is acceptable.
function passwordPolicyError(p) {
  p = String(p || '');
  if (p.length < 10) return 'Password must be at least 10 characters long.';
  if (!/[A-Z]/.test(p)) return 'Password must contain an uppercase letter.';
  if (!/[0-9]/.test(p)) return 'Password must contain a number.';
  if (!/[^A-Za-z0-9]/.test(p)) return 'Password must contain a special character.';
  return null;
}

router.post('/change-password', async (req, res) => {
  try {
    const { current_password, new_password } = req.body || {};
    const uid = req.user.user_id;
    const u = await one('SELECT password_hash FROM sec_user WHERE user_id=$1 AND is_active', [uid]);
    if (!u || !verifyPassword(u.password_hash, current_password || '')) return res.status(400).json({ error: 'Current password is incorrect.' });
    const policyErr = passwordPolicyError(new_password);
    if (policyErr) return res.status(400).json({ error: policyErr });
    if (verifyPassword(u.password_hash, new_password)) return res.status(400).json({ error: 'New password must be different from the current one.' });
    await q('UPDATE sec_user SET password_hash=$1, must_change_password=FALSE, updated_by=$2, updated_at=now() WHERE user_id=$3',
      [hashPassword(new_password), uid, uid]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = { router, passwordPolicyError };
