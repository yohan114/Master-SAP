// Migrate the real legacy catalog into the unified PostgreSQL.
// Reads the two legacy SQLite books and loads masters (items, oil products, fleet
// assets, batteries) into md_item / md_asset / md_battery. Run AFTER `node seed.js`
// (uses its admin user + HQ site + NOS/LTR UoM). Uses distinct item_no prefixes so it
// never clashes with the demo seed. Idempotent via ON CONFLICT.
//
//   STORES_DB=/path/inventory.db OIL_DB=/path/oilbook.db node migrate-legacy.js
const { DatabaseSync } = require('node:sqlite');
const { q, one, tx } = require('./db');

const STORES_DB = process.env.STORES_DB;
const OIL_DB = process.env.OIL_DB;
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const pad = (n, w) => String(n).padStart(w, '0');
const MACHINE = /excavat|loader|roller|backhoe|skid|dozer|grader|crane|forklift|compactor|paver|mixer|generator|pump/i;

(async () => {
  const admin = await one("SELECT user_id FROM sec_user WHERE username='admin'");
  if (!admin) throw new Error('run `node seed.js` first (needs the admin user + base masters)');
  const CB = admin.user_id;
  const site = await one("SELECT location_id FROM md_location WHERE location_code='HQ'");
  const nos = await one("SELECT uom_id FROM md_uom WHERE uom_code='NOS'");
  const ltr = await one("SELECT uom_id FROM md_uom WHERE uom_code='LTR'");
  const siteId = site.location_id;

  // category cache (create on demand)
  const catCache = new Map();
  async function categoryId(c, name) {
    const key = norm(name) || 'uncategorised';
    if (catCache.has(key)) return catCache.get(key);
    const code = ('C-' + key.replace(/[^a-z0-9]+/g, '_')).slice(0, 20);
    const row = (await c.query(
      `INSERT INTO md_item_category(category_code, category_name, created_by) VALUES($1,$2,$3)
       ON CONFLICT (category_code) DO UPDATE SET category_name=EXCLUDED.category_name RETURNING category_id`,
      [code, (name || 'Uncategorised').slice(0, 120), CB])).rows[0];
    catCache.set(key, row.category_id);
    return row.category_id;
  }

  const summary = {};

  // ---- Stores items (distinct) + general items --------------------------
  if (STORES_DB) {
    const inv = new DatabaseSync(STORES_DB, { readOnly: true });
    const seen = new Set();
    let n = 0;
    await tx(async (c) => {
      const rows = inv.prepare(`SELECT itemName, MAX(itemDesc) desc, MAX(category) cat FROM items
        WHERE TRIM(COALESCE(itemName,''))<>'' GROUP BY LOWER(TRIM(itemName))`).all();
      for (const r of rows) {
        const key = norm(r.itemName); if (seen.has(key)) continue; seen.add(key);
        const cat = await categoryId(c, r.cat);
        await c.query(
          `INSERT INTO md_item(item_no, item_name, item_type, category_id, base_uom_id, specification, created_by)
           VALUES($1,$2,'SPARE',$3,$4,$5,$6) ON CONFLICT (item_no) DO NOTHING`,
          [`SPR-${pad(++n, 5)}`, String(r.itemName).slice(0, 150), cat, nos.uom_id, (r.desc || '').slice(0, 400), CB]);
      }
    });
    summary.spare_items = n;

    let g = 0;
    await tx(async (c) => {
      for (const r of inv.prepare(`SELECT itemName, partNumber, category, specification FROM general_items`).all()) {
        const cat = await categoryId(c, r.category || 'General');
        await c.query(
          `INSERT INTO md_item(item_no, item_name, item_type, category_id, base_uom_id, specification, created_by)
           VALUES($1,$2,'GENERAL',$3,$4,$5,$6) ON CONFLICT (item_no) DO NOTHING`,
          [`GEN-${pad(++g, 4)}`, String(r.itemName || 'General item').slice(0, 150), cat, nos.uom_id, (r.specification || '').slice(0, 400), CB]);
      }
    });
    summary.general_items = g;

    // ---- Batteries -> md_battery (+ install if the legacy unit is on a vehicle) ----
    await tx(async (c) => {
      const model = (await c.query(
        `INSERT INTO md_item(item_no, item_name, item_type, base_uom_id, created_by)
         VALUES('BTM-LEG','Battery (legacy)','BATTERY',$1,$2) ON CONFLICT (item_no) DO UPDATE SET item_name=EXCLUDED.item_name RETURNING item_id`,
        [nos.uom_id, CB])).rows[0];
      let b = 0;
      for (const r of inv.prepare(`SELECT serialNumber, currentVehicle, state FROM batteries WHERE TRIM(COALESCE(serialNumber,''))<>''`).all()) {
        const installed = norm(r.state) === 'installed';
        let asset = null;
        if (installed && r.currentVehicle) {
          asset = (await c.query(`SELECT asset_id FROM md_asset WHERE LOWER(REPLACE(asset_no,'FLT-',''))=$1 OR LOWER(asset_name) LIKE $2 LIMIT 1`,
            [norm(r.currentVehicle), '%' + norm(r.currentVehicle) + '%'])).rows[0];
        }
        const status = asset ? 'IN_SERVICE' : 'IN_STOCK';
        const bat = (await c.query(
          `INSERT INTO md_battery(battery_serial_no, item_id, current_asset_id, original_asset_id, current_location_id, battery_status, site_id, created_by)
           VALUES($1,$2,$3,$3,$4,$5,$6,$7) ON CONFLICT (battery_serial_no) DO NOTHING RETURNING battery_id`,
          [String(r.serialNumber).slice(0, 50), model.item_id, asset ? asset.asset_id : null,
           asset ? null : siteId, status, siteId, CB])).rows[0];
        if (!bat) continue; b++;
        await c.query(
          `INSERT INTO hist_battery_event(battery_id, event_seq, event_type, event_date, to_status, source_doc_type, site_id, created_by)
           VALUES($1,1,'RECEIVED',CURRENT_DATE,'IN_STOCK','GRN',$2,$3)`, [bat.battery_id, siteId, CB]);
        if (asset) await c.query(
          `INSERT INTO hist_battery_event(battery_id, event_seq, event_type, event_date, to_asset_id, to_status, source_doc_type, site_id, created_by)
           VALUES($1,2,'INSTALLED',CURRENT_DATE,$2,'IN_SERVICE','BAT',$3,$4)`, [bat.battery_id, asset.asset_id, siteId, CB]);
      }
      summary.batteries = b;
    });
    inv.close();
  }

  // ---- Oil products -----------------------------------------------------
  if (OIL_DB) {
    const oil = new DatabaseSync(OIL_DB, { readOnly: true });
    let n = 0;
    await tx(async (c) => {
      for (const r of oil.prepare(`SELECT name, unit, category FROM products WHERE TRIM(COALESCE(name,''))<>''`).all()) {
        const cat = await categoryId(c, r.category || 'Lubricant');
        const uom = /l/i.test(r.unit || 'L') ? ltr.uom_id : nos.uom_id;
        await c.query(
          `INSERT INTO md_item(item_no, item_name, item_type, category_id, base_uom_id, created_by)
           VALUES($1,$2,'LUBRICANT',$3,$4,$5) ON CONFLICT (item_no) DO NOTHING`,
          [`LUB-${pad(++n, 3)}`, String(r.name).slice(0, 150), cat, uom, CB]);
      }
    });
    summary.oil_products = n;

    // ---- Fleet assets ---------------------------------------------------
    let a = 0;
    await tx(async (c) => {
      for (const r of oil.prepare(`SELECT ec_code, registration, brand, type, model_no FROM fleet_assets`).all()) {
        const code = (r.ec_code || r.registration || `A${a + 1}`).toString().trim();
        const cls = MACHINE.test(r.type || '') ? 'MACHINE' : 'VEHICLE';
        const name = [r.brand, r.type, r.registration].filter(Boolean).join(' ').slice(0, 150) || code;
        await c.query(
          `INSERT INTO md_asset(asset_no, asset_name, asset_class, site_id, created_by)
           VALUES($1,$2,$3,$4,$5) ON CONFLICT (asset_no) DO NOTHING`,
          [`FLT-${code}`.slice(0, 30), name, cls, siteId, CB]);
        a++;
      }
    });
    summary.fleet_assets = a;
    oil.close();
  }

  const totals = await one(`SELECT
    (SELECT count(*) FROM md_item) items, (SELECT count(*) FROM md_item WHERE item_type='LUBRICANT') lubricants,
    (SELECT count(*) FROM md_asset) assets, (SELECT count(*) FROM md_battery) batteries,
    (SELECT count(*) FROM md_battery WHERE battery_status='IN_SERVICE') batteries_installed`);
  console.log('Loaded this run:', JSON.stringify(summary));
  console.log('Now in the unified DB:', JSON.stringify(totals));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
