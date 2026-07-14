// Idempotent seed: schema + roles/permissions + first admin + sample users, sites, and stock.
const fs = require('fs');
const path = require('path');
const { exec, run, get } = require('./db');
const { hashPassword } = require('./auth/password');

(async () => {
  exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  for (const t of ['sessions', 'audit_log', 'sec_user_site', 'sec_user_role', 'sec_role_permission',
                   'sec_permission', 'sec_role', 'sec_user', 'stock', 'md_location']) run(`DELETE FROM ${t}`);

  run("INSERT INTO md_location(id,code,name) VALUES (1,'CMB','Colombo'),(2,'KND','Kandy')");

  const PERMS = ['STORES.READ', 'STORES.ISSUE', 'STORES.PRICE', 'STORES.DELETE',
                 'READ.ALL_SITES', 'ADMIN.ALL', 'WORKSHOP.APPROVE.OM'];
  PERMS.forEach((p) => run('INSERT INTO sec_permission(permission_code,module,action) VALUES(?,?,?)',
    [p, p.split('.')[0], p.split('.').slice(1).join('.')]));
  const pid = (c) => get('SELECT id FROM sec_permission WHERE permission_code=?', [c]).id;

  const ROLES = {
    system_admin:   ['ADMIN.ALL'],
    pricing_officer:['STORES.READ', 'STORES.PRICE', 'READ.ALL_SITES'],
    store_keeper:   ['STORES.READ', 'STORES.ISSUE'], // site-scoped, cannot price or delete
  };
  const rid = {};
  for (const [rc, ps] of Object.entries(ROLES)) {
    run('INSERT INTO sec_role(role_code,role_name) VALUES(?,?)', [rc, rc]);
    rid[rc] = get('SELECT id FROM sec_role WHERE role_code=?', [rc]).id;
    ps.forEach((p) => run('INSERT INTO sec_role_permission(role_id,permission_id) VALUES(?,?)', [rid[rc], pid(p)]));
  }

  async function user(username, pw, fullName, role, sites = []) {
    run('INSERT INTO sec_user(username,password_hash,full_name) VALUES(?,?,?)', [username, await hashPassword(pw), fullName]);
    const id = get('SELECT id FROM sec_user WHERE username=?', [username]).id;
    run('INSERT INTO sec_user_role(user_id,role_id) VALUES(?,?)', [id, rid[role]]);
    sites.forEach((s) => run('INSERT INTO sec_user_site(user_id,location_id) VALUES(?,?)', [id, s]));
  }
  await user('admin',      'Admin@12345',  'System Admin',     'system_admin');
  await user('pricing',    'Pricing@123',  'Pricing Officer',  'pricing_officer');
  await user('keeper_cmb', 'Keeper@cmb1',  'CMB Store Keeper', 'store_keeper', [1]);
  await user('keeper_knd', 'Keeper@knd1',  'KND Store Keeper', 'store_keeper', [2]);

  run("INSERT INTO stock(item,site_id,qty,unit_price) VALUES " +
      "('Oil Filter DENSO',1,40,1250),('Brake Pad Set',1,12,8400),('Battery N200',2,6,22500),('Coolant Hose',2,80,640)");

  console.log('Seeded. Logins:');
  console.log('  admin/Admin@12345 (all sites, admin)   pricing/Pricing@123 (can price)');
  console.log('  keeper_cmb/Keeper@cmb1 (CMB only)       keeper_knd/Keeper@knd1 (KND only)');
})();
