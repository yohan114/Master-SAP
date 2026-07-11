// Minimal JWT (HS256) using Node's crypto — no external dependency, matching the app's zero-native-dep
// stance. Enough for signing/verifying service-account access tokens for the /api/v1 REST layer.
const crypto = require('crypto');

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function sign(payload, secret) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verify(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const data = `${parts[0]}.${parts[1]}`;
  const expected = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  const got = Buffer.from(parts[2]);
  const exp = Buffer.from(expected);
  if (got.length !== exp.length || !crypto.timingSafeEqual(got, exp)) throw new Error('bad signature');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  if (payload.exp && Math.floor(Date.now() / 1000) >= payload.exp) throw new Error('token expired');
  return payload;
}

module.exports = { sign, verify };
