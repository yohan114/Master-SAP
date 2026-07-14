// Password hashing. Uses argon2id if the package is installed (production default),
// otherwise falls back to Node's built-in crypto.scrypt so the module runs with no native build.
const crypto = require('crypto');
let argon2 = null;
try { argon2 = require('argon2'); } catch (_) { /* fall back to scrypt */ }

const N = 16384, r = 8, p = 1, KEYLEN = 64;

async function hashPassword(pw) {
  if (argon2) return argon2.hash(pw, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(pw, salt, KEYLEN, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${dk.toString('hex')}`;
}

async function verifyPassword(stored, pw) {
  if (!stored) return false;
  if (stored.startsWith('$argon2')) return argon2 ? argon2.verify(stored, pw) : false;
  const [tag, n, rr, pp, saltHex, hashHex] = stored.split('$');
  if (tag !== 'scrypt') return false;
  const expected = Buffer.from(hashHex, 'hex');
  const dk = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length, { N: +n, r: +rr, p: +pp });
  return dk.length === expected.length && crypto.timingSafeEqual(dk, expected);
}

module.exports = { hashPassword, verifyPassword, usingArgon2: !!argon2 };
