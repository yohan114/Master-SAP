// One-time seed: roles, permissions, and a first admin for the storesdb app.
// Run once:  node seed-users.js    (safe to re-run; upserts by username)
require('./auth/schema').ensure();
const { get, run } = require('./db');
const { hashPassword } = require('./auth/password');

const PERMS = ['STORES.READ', 'STORES.WRITE', 'STORES.ISSUE', 'STORES.TRANSFER', 'STORES.PRICE', 'STORES.DELETE', 'ADMIN.ALL'];
const ROLES = {
  system_admin:    ['ADMIN.ALL'],
  store_keeper:    ['STORES.READ', 'STORES.WRITE', 'STORES.ISSUE', 'STORES.TRANSFER'], // create/receive/issue/transfer; NOT price or delete
  pricing_officer: ['STORES.READ', 'STORES.PRICE'],                                    // pricing only
};
const USERS = [
  ['admin',   'ChangeMe@Admin1', 'System Admin',   'system_admin'],
  ['keeper',  'ChangeMe@Keep1',  'Store Keeper',   'store_keeper'],
  ['pricing', 'ChangeMe@Price1', 'Pricing Officer','pricing_officer'],
];

(async () => {
  PERMS.forEach((p) => run('INSERT OR IGNORE INTO sec_permission(permission_code,module,action) VALUES(?,?,?)',
    [p, p.split('.')[0], p.split('.').slice(1).join('.')]));
  const pid = (c) => get('SELECT id FROM sec_permission WHERE permission_code=?', [c]).id;
  for (const [rc, ps] of Object.entries(ROLES)) {
    run('INSERT OR IGNORE INTO sec_role(role_code,role_name) VALUES(?,?)', [rc, rc]);
    const rid = get('SELECT id FROM sec_role WHERE role_code=?', [rc]).id;
    ps.forEach((p) => run('INSERT OR IGNORE INTO sec_role_permission(role_id,permission_id) VALUES(?,?)', [rid, pid(p)]));
  }
  for (const [un, pw, fn, role] of USERS) {
    const h = await hashPassword(pw);
    run(`INSERT INTO sec_user(username,password_hash,full_name) VALUES(?,?,?)
         ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash`, [un, h, fn]);
    const uid = get('SELECT id FROM sec_user WHERE username=?', [un]).id;
    const rid = get('SELECT id FROM sec_role WHERE role_code=?', [role]).id;
    run('INSERT OR IGNORE INTO sec_user_role(user_id,role_id) VALUES(?,?)', [uid, rid]);
  }
  console.log('Seeded roles/permissions and users:');
  USERS.forEach(([un, pw, , role]) => console.log(`  ${un} / ${pw}  (${role})  <- CHANGE THESE ON FIRST LOGIN`));
})();
