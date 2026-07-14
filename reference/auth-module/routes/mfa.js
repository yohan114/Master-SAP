// MFA enrolment (authenticated). setup -> returns a secret + otpauth URI for the authenticator app;
// enable -> verifies a code and turns MFA on; disable -> turns it off.
const express = require('express');
const { get, run } = require('../db');
const { generateSecret, verifyTotp, otpauthURI } = require('../auth/totp');
const { audit } = require('../auth/audit');

const router = express.Router();

router.post('/setup', (req, res) => {
  const secret = generateSecret();
  run('UPDATE sec_user SET mfa_secret = ?, mfa_enabled = 0 WHERE id = ?', [secret, req.user.id]);
  res.json({ secret, otpauth: otpauthURI(secret, req.user.username) }); // render otpauth as a QR client-side
});

router.post('/enable', (req, res) => {
  const u = get('SELECT mfa_secret FROM sec_user WHERE id = ?', [req.user.id]);
  if (!u || !verifyTotp(u.mfa_secret, (req.body || {}).token)) {
    return res.status(400).json({ error: 'Invalid authenticator code.' });
  }
  run('UPDATE sec_user SET mfa_enabled = 1 WHERE id = ?', [req.user.id]);
  audit('MFA_ENABLE', { userId: req.user.id });
  res.json({ ok: true });
});

router.post('/disable', (req, res) => {
  run('UPDATE sec_user SET mfa_enabled = 0, mfa_secret = NULL WHERE id = ?', [req.user.id]);
  audit('MFA_DISABLE', { userId: req.user.id });
  res.json({ ok: true });
});

module.exports = router;
