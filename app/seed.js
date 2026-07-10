// Seed the minimum masters + users to exercise the Workshop module.
// Idempotent-ish: safe on a freshly-loaded schema; re-running may duplicate demo masters.
const { q, one, tx } = require('./db');
const { hashPassword } = require('./auth/password');

const PERMS = ['ADMIN.ALL', 'READ.ALL_SITES', 'JOB.WRITE', 'JOB.LABOUR', 'JOB.PARTS', 'JOB.COST', 'JOB.CLOSE',
  'STORES.RECEIVE', 'STORES.ISSUE', 'STORES.READ'];
const ROLES = {
  system_admin: ['ADMIN.ALL', 'READ.ALL_SITES'],
  foreman:      ['JOB.WRITE', 'JOB.LABOUR', 'JOB.PARTS', 'JOB.COST', 'JOB.CLOSE', 'STORES.ISSUE', 'STORES.READ'],
  storekeeper:  ['STORES.RECEIVE', 'STORES.ISSUE', 'STORES.READ'],
  viewer:       [],
};
const USERS = [
  ['admin',   'ChangeMe@Admin1', 'System Admin', 'system_admin'],
  ['foreman', 'ChangeMe@Fore1',  'Workshop Foreman', 'foreman'],
  ['keeper',  'ChangeMe@Keep1',  'Store Keeper', 'storekeeper'],
  ['viewer',  'ChangeMe@View1',  'Read Only', 'viewer'],
];

(async () => {
  await tx(async (c) => {
    const run = (t, p) => c.query(t, p).then((r) => r.rows);

    // 1) bootstrap admin (created_by self-reference, resolved before commit under deferred constraints)
    const existing = await run('SELECT user_id FROM sec_user WHERE username=$1', ['admin']);
    let adminId;
    if (existing.length) { adminId = existing[0].user_id; }
    else {
      const ins = await run(
        `INSERT INTO sec_user(username, full_name, password_hash, created_by)
         VALUES('admin','System Admin',$1, 1) RETURNING user_id`, [hashPassword('ChangeMe@Admin1')]);
      adminId = ins[0].user_id;
      await run('UPDATE sec_user SET created_by=$1 WHERE user_id=$1', [adminId]);
    }
    const CB = adminId;

    // 2) permissions + roles
    for (const p of PERMS)
      await run(`INSERT INTO sec_permission(permission_code, permission_name, module, action, created_by)
                 VALUES($1,$2,$3,$4,$5) ON CONFLICT (permission_code) DO NOTHING`,
                [p, p, p.split('.')[0].slice(0, 20), (p.split('.').slice(1).join('_') || 'ALL').slice(0, 20), CB]);
    const pid = async (code) => (await run('SELECT permission_id FROM sec_permission WHERE permission_code=$1', [code]))[0].permission_id;
    for (const [rc, ps] of Object.entries(ROLES)) {
      await run(`INSERT INTO sec_role(role_code, role_name, created_by) VALUES($1,$2,$3)
                 ON CONFLICT (role_code) DO NOTHING`, [rc, rc, CB]);
      const rid = (await run('SELECT role_id FROM sec_role WHERE role_code=$1', [rc]))[0].role_id;
      for (const p of ps)
        await run(`INSERT INTO sec_role_permission(role_id, permission_id, created_by) VALUES($1,$2,$3)
                   ON CONFLICT (role_id, permission_id) DO NOTHING`, [rid, await pid(p), CB]);
    }

    // 3) users
    for (const [un, pw, fn, role] of USERS) {
      await run(`INSERT INTO sec_user(username, full_name, password_hash, created_by) VALUES($1,$2,$3,$4)
                 ON CONFLICT (username) DO UPDATE SET password_hash=EXCLUDED.password_hash`,
                [un, fn, hashPassword(pw), CB]);
      const uid = (await run('SELECT user_id FROM sec_user WHERE username=$1', [un]))[0].user_id;
      const rid = (await run('SELECT role_id FROM sec_role WHERE role_code=$1', [role]))[0].role_id;
      await run('INSERT INTO sec_user_role(user_id, role_id, created_by) VALUES($1,$2,$3) ON CONFLICT (user_id, role_id) DO NOTHING', [uid, rid, CB]);
    }

    // 4) masters: site, uom, item category + item, asset, grade + labour rate + technician
    const site = (await run(`INSERT INTO md_location(location_code, location_name, location_type, site_code, created_by)
      VALUES('HQ','Head Office Workshop','SITE','HQ',$1)
      ON CONFLICT DO NOTHING RETURNING location_id`, [CB]))[0]
      || (await run("SELECT location_id FROM md_location WHERE location_code='HQ'"))[0];
    const siteId = site.location_id;

    const uom = (await run(`INSERT INTO md_uom(uom_code, uom_name, created_by) VALUES('NOS','Numbers',$1)
      ON CONFLICT (uom_code) DO NOTHING RETURNING uom_id`, [CB]))[0]
      || (await run("SELECT uom_id FROM md_uom WHERE uom_code='NOS'"))[0];
    const uomId = uom.uom_id;

    const cat = (await run(`INSERT INTO md_item_category(category_code, category_name, created_by) VALUES('SPARE','Spare Parts',$1)
      ON CONFLICT (category_code) DO NOTHING RETURNING category_id`, [CB]))[0]
      || (await run("SELECT category_id FROM md_item_category WHERE category_code='SPARE'"))[0];

    await run(`INSERT INTO md_item(item_no, item_name, item_type, category_id, base_uom_id, created_by)
      VALUES('SP-0001','Brake Pad Set','SPARE',$1,$2,$3) ON CONFLICT (item_no) DO NOTHING`, [cat.category_id, uomId, CB]);
    await run(`INSERT INTO md_item(item_no, item_name, item_type, base_uom_id, created_by)
      VALUES('GN-0001','Shop Rag','GENERAL',$1,$2) ON CONFLICT (item_no) DO NOTHING`, [uomId, CB]);

    await run(`INSERT INTO md_asset(asset_no, asset_name, asset_class, site_id, created_by)
      VALUES('VEH-0001','Tipper Truck 01','VEHICLE',$1,$2) ON CONFLICT (asset_no) DO NOTHING`, [siteId, CB]);

    await run(`INSERT INTO md_supplier(supplier_no, supplier_name, created_by)
      SELECT 'SUP-0001','General Supplier',$1
      WHERE NOT EXISTS (SELECT 1 FROM md_supplier WHERE supplier_no='SUP-0001')`, [CB]);

    const grade = (await run(`INSERT INTO md_employee_grade(grade_code, grade_name, created_by) VALUES('MECH','Mechanic',$1)
      ON CONFLICT (grade_code) DO NOTHING RETURNING grade_id`, [CB]))[0]
      || (await run("SELECT grade_id FROM md_employee_grade WHERE grade_code='MECH'"))[0];
    await run(`INSERT INTO md_labour_rate(grade_id, effective_date, hourly_rate, ot_multiplier, rate_status, created_by)
      VALUES($1,'2025-01-01',500.00,1.5,'CONFIRMED',$2) ON CONFLICT (grade_id, effective_date) DO NOTHING`, [grade.grade_id, CB]);
    await run(`INSERT INTO md_employee(employee_no, employee_name, is_technician, grade_id, site_id, created_by)
      VALUES('EMP-0001','A. Perera',TRUE,$1,$2,$3) ON CONFLICT (employee_no) DO NOTHING`, [grade.grade_id, siteId, CB]);
  });
  const ids = await one(`SELECT
     (SELECT location_id FROM md_location WHERE location_code='HQ') site,
     (SELECT asset_id FROM md_asset WHERE asset_no='VEH-0001') asset,
     (SELECT item_id FROM md_item WHERE item_no='SP-0001') spare,
     (SELECT item_id FROM md_item WHERE item_no='GN-0001') general,
     (SELECT employee_id FROM md_employee WHERE employee_no='EMP-0001') tech`);
  console.log('Seeded. Logins: admin/ChangeMe@Admin1  foreman/ChangeMe@Fore1  viewer/ChangeMe@View1');
  console.log('Demo ids:', JSON.stringify(ids));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
