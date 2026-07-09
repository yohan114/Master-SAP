// RFC 6238 TOTP (2FA) — zero dependencies, uses Node's crypto. Base32 secrets, SHA-1, 6 digits, 30s.
const crypto = require('crypto');
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32encode(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function base32decode(str) {
  str = String(str).replace(/=+$/, '').toUpperCase();
  let bits = 0, val = 0; const out = [];
  for (const c of str) { const i = B32.indexOf(c); if (i < 0) continue; val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8; } }
  return Buffer.from(out);
}
function hotp(secret, counter) {
  const key = base32decode(secret);
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h[off] & 0x7f) << 24) | ((h[off + 1] & 0xff) << 16) | ((h[off + 2] & 0xff) << 8) | (h[off + 3] & 0xff);
  return String(code % 1000000).padStart(6, '0');
}
const generateSecret = (len = 20) => base32encode(crypto.randomBytes(len));
const totp = (secret, t = Date.now(), step = 30) => hotp(secret, Math.floor((t / 1000) / step));
function verifyTotp(secret, token, t = Date.now(), window = 1) {
  if (!secret || token == null) return false;
  token = String(token).trim();
  if (!/^\d{6}$/.test(token)) return false;            // exactly 6 digits — keeps timingSafeEqual buffers equal-length
  const cand = Buffer.from(token);
  const c = Math.floor((t / 1000) / 30);
  let match = false;
  for (let i = -window; i <= window; i++) if (crypto.timingSafeEqual(Buffer.from(hotp(secret, c + i)), cand)) match = true;
  return match;                                        // no early return — constant-ish across the window
}
const otpauthURI = (secret, label, issuer = 'UMMS') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

module.exports = { generateSecret, totp, verifyTotp, otpauthURI };
