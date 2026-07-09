// End-to-end smoke test — proves auth, RBAC, site scoping, MFA, and lockout against a running server.
import totpmod from './auth/totp.js';
const BASE = process.env.BASE || 'http://127.0.0.1:4100';
let pass = 0, fail = 0;
const assert = (name, cond) => { (cond ? pass++ : fail++); console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); };

async function login(username, password) {
  const r = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const cookie = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  return { status: r.status, cookie, body: await r.json().catch(() => ({})) };
}
async function req(path, cookie, opts = {}) {
  const r = await fetch(`${BASE}${path}`, { ...opts, headers: { ...(opts.headers || {}), cookie } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function loginMfa(username, password, token) {
  const r = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, token }) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

(async () => {
  console.log('AUTHENTICATION');
  assert('wrong password -> 401', (await login('admin', 'nope')).status === 401);
  const admin = await login('admin', 'Admin@12345');
  assert('admin login -> 200 + cookie', admin.status === 200 && !!admin.cookie);
  assert('no cookie -> 401', (await req('/api/stock', '')).status === 401);

  console.log('RBAC + SITE SCOPING');
  const aStock = await req('/api/stock', admin.cookie);
  assert('admin sees ALL sites (4 rows)', aStock.body.count === 4);
  const knd = await login('keeper_knd', 'Keeper@knd1');
  const kStock = await req('/api/stock', knd.cookie);
  assert('KND keeper sees ONLY KND (2 rows)', kStock.body.count === 2 && kStock.body.rows.every((r) => r.site_id === 2));
  const kPrice = await req('/api/grn/1/price', knd.cookie, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ unit_price: 999 }) });
  assert('store keeper CANNOT price -> 403', kPrice.status === 403);
  const pr = await login('pricing', 'Pricing@123');
  const pPrice = await req('/api/grn/1/price', pr.cookie, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ unit_price: 1500 }) });
  assert('pricing officer CAN price -> 200', pPrice.status === 200);

  console.log('DELETE (replaces the hard-coded password)');
  assert('store keeper CANNOT delete -> 403', (await req('/api/items/3', knd.cookie, { method: 'DELETE' })).status === 403);
  assert('admin CAN delete -> 200', (await req('/api/items/3', admin.cookie, { method: 'DELETE' })).status === 200);

  console.log('MFA (2FA — required for admin)');
  const setup = await req('/auth/mfa/setup', admin.cookie, { method: 'POST' });
  const secret = setup.body.secret;
  assert('mfa setup returns a secret + otpauth URI', setup.status === 200 && !!secret && /^otpauth:/.test(setup.body.otpauth || ''));
  const enable = await req('/auth/mfa/enable', admin.cookie, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: totpmod.totp(secret) }) });
  assert('mfa enable with a valid code -> 200', enable.status === 200);
  const noCode = await login('admin', 'Admin@12345');
  assert('admin login WITHOUT code now -> 401 (mfa required)', noCode.status === 401 && noCode.body.mfa === true);
  assert('admin login WRONG code -> 401', (await loginMfa('admin', 'Admin@12345', '000000')).status === 401);
  assert('admin login VALID code -> 200', (await loginMfa('admin', 'Admin@12345', totpmod.totp(secret))).status === 200);

  console.log('ACCOUNT LOCKOUT');
  for (let i = 0; i < 5; i++) await login('keeper_cmb', 'wrong');
  assert('locks after 5 failures -> 401 even with right password',
    (await login('keeper_cmb', 'Keeper@cmb1')).status === 401);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
