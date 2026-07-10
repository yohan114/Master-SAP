// Password hashing — scrypt (Node crypto, zero native deps). Format: scrypt$N$salt$hash.
const crypto = require('crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const N = 16384;
  const hash = crypto.scryptSync(String(password), salt, 64, { N, r: 8, p: 1 });
  return `scrypt$${N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(stored, password) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, nStr, saltB64, hashB64] = stored.split('$');
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(String(password), salt, expected.length, { N: Number(nStr), r: 8, p: 1 });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

module.exports = { hashPassword, verifyPassword };
