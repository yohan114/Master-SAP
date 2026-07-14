// Battery module — serial-true lifecycle. Each physical battery is one md_battery row;
// every move is an append-only hist_battery_event, so the full history (and original vs
// current vehicle) is always preserved. Register -> install -> transfer -> return -> scrap.
const express = require('express');
const { q, one, tx } = require('../db');
const { requirePerm, scopeSql } = require('../auth/mw');
const { nextNo } = require('../lib/numbering');

const router = express.Router();
const today = () => new Date().toISOString().slice(0, 10);
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function siteCode(c, siteId) {
  const r = (await c.query('SELECT site_code, location_code FROM md_location WHERE location_id=$1', [siteId])).rows[0];
  return (r && (r.site_code || r.location_code || 'HQ')).trim().slice(0, 3).toUpperCase();
}

// Append a lifecycle event and move the battery's live state in lock-step.
async function moveBattery(c, bat, ev, userId) {
  const seq = (await c.query('SELECT COALESCE(MAX(event_seq),0)+1 AS n FROM hist_battery_event WHERE battery_id=$1', [bat.battery_id])).rows[0].n;
  const docNo = await nextNo('BAT', await siteCode(c, bat.site_id), ev.event_date, c);
  const e = (await c.query(
    `INSERT INTO hist_battery_event(battery_id, event_seq, event_type, event_date, from_asset_id, to_asset_id,
         from_location_id, to_location_id, meter_reading, from_status, to_status, source_doc_type, source_doc_no,
         event_value_amt, remarks, site_id, created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'BAT',$12,$13,$14,$15,$16) RETURNING event_id`,
    [bat.battery_id, seq, ev.event_type, ev.event_date, ev.from_asset_id || null, ev.to_asset_id || null,
     ev.from_location_id || null, ev.to_location_id || null, ev.meter_reading || null, bat.battery_status,
     ev.to_status, docNo, ev.event_value_amt || null, ev.remarks || null, bat.site_id, userId])).rows[0];
  await c.query(
    `UPDATE md_battery SET battery_status=$1, current_asset_id=$2, current_location_id=$3,
         original_asset_id=COALESCE(original_asset_id,$4), last_event_id=$5, updated_by=$6, updated_at=now()
     WHERE battery_id=$7`,
    [ev.to_status, ev.to_asset_id ?? null, ev.to_location_id ?? null, ev.set_original || null, e.event_id, userId, bat.battery_id]);
  return { event_id: e.event_id, event_seq: seq, source_doc_no: docNo };
}
const load = (id) => one('SELECT * FROM md_battery WHERE battery_id=$1', [id]);

// List batteries (site-scoped) with model + where they are now.
router.get('/', async (req, res) => {
  try {
    const sc = scopeSql(req, 'bt', 1);
    const rows = await q(`SELECT bt.battery_id, bt.battery_serial_no, i.item_name AS model, bt.battery_status,
        bt.current_asset_id, ca.asset_no AS current_asset, bt.original_asset_id, oa.asset_no AS original_asset
      FROM md_battery bt JOIN md_item i ON i.item_id=bt.item_id
      LEFT JOIN md_asset ca ON ca.asset_id=bt.current_asset_id
      LEFT JOIN md_asset oa ON oa.asset_id=bt.original_asset_id
      WHERE bt.is_active${sc.sql} ORDER BY bt.battery_id DESC LIMIT 300`, sc.params);
    res.json({ count: rows.length, rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Battery + its full event history.
router.get('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const sc = scopeSql(req, 'bt', 2);
    const bat = await one(`SELECT bt.*, i.item_name AS model FROM md_battery bt JOIN md_item i ON i.item_id=bt.item_id
      WHERE bt.battery_id=$1${sc.sql}`, [id, ...sc.params]);
    if (!bat) return res.status(404).json({ error: 'Battery not found' });
    bat.history = await q(`SELECT event_seq, event_type, event_date, from_asset_id, to_asset_id, from_status, to_status, source_doc_no
      FROM hist_battery_event WHERE battery_id=$1 ORDER BY event_seq`, [id]);
    res.json(bat);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Register a newly-received battery into stock.
router.post('/register', requirePerm('BATTERY.WRITE'), async (req, res) => {
  try {
    const b = req.body || {};
    const { serial_no, item_id, location_id, capacity_ah = null, voltage = null, acquisition_cost = 0,
            warranty_start_date = null, warranty_end_date = null } = b;
    if (!serial_no || !item_id || !location_id) return res.status(400).json({ error: 'serial_no, item_id, location_id required' });
    const site_id = b.site_id || location_id;
    const out = await tx(async (c) => {
      const bat = (await c.query(
        `INSERT INTO md_battery(battery_serial_no, item_id, capacity_ah, voltage, acquisition_cost,
             purchase_date, warranty_start_date, warranty_end_date, current_location_id, battery_status, site_id, created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'IN_STOCK',$10,$11) RETURNING *`,
        [serial_no, item_id, capacity_ah, voltage, money(acquisition_cost), today(), warranty_start_date, warranty_end_date, location_id, site_id, req.user.user_id])).rows[0];
      const ev = await moveBattery(c, bat, { event_type: 'RECEIVED', event_date: today(),
        to_location_id: location_id, to_status: 'IN_STOCK', event_value_amt: money(acquisition_cost) }, req.user.user_id);
      return { battery_id: bat.battery_id, serial_no, battery_status: 'IN_STOCK', ...ev };
    });
    res.json(out);
  } catch (e) { res.status(400).json({ error: /unique/i.test(e.message) ? `serial ${req.body.serial_no} already registered` : e.message }); }
});

// Install onto a vehicle/machine (from stock). First install sets the original asset.
router.post('/:id/install', requirePerm('BATTERY.ISSUE'), async (req, res) => {
  try {
    const id = Number(req.params.id); const b = req.body || {};
    if (!b.asset_id) return res.status(400).json({ error: 'asset_id required' });
    const bat = await load(id);
    if (!bat) return res.status(404).json({ error: 'Battery not found' });
    if (!['IN_STOCK', 'RETURNED', 'REPAIRED'].includes(bat.battery_status))
      return res.status(409).json({ error: `battery is ${bat.battery_status}, not available to install` });
    const out = await tx((c) => moveBattery(c, bat, { event_type: 'INSTALLED', event_date: b.event_date || today(),
      from_location_id: bat.current_location_id, to_asset_id: b.asset_id, to_status: 'IN_SERVICE',
      set_original: b.asset_id, meter_reading: b.meter_reading }, req.user.user_id));
    res.json({ battery_status: 'IN_SERVICE', current_asset_id: Number(b.asset_id), ...out });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Transfer directly from one asset to another.
router.post('/:id/transfer', requirePerm('BATTERY.ISSUE'), async (req, res) => {
  try {
    const id = Number(req.params.id); const b = req.body || {};
    if (!b.asset_id) return res.status(400).json({ error: 'asset_id required' });
    const bat = await load(id);
    if (!bat) return res.status(404).json({ error: 'Battery not found' });
    if (bat.battery_status !== 'IN_SERVICE') return res.status(409).json({ error: 'battery is not in service' });
    const out = await tx((c) => moveBattery(c, bat, { event_type: 'TRANSFERRED', event_date: b.event_date || today(),
      from_asset_id: bat.current_asset_id, to_asset_id: b.asset_id, to_status: 'IN_SERVICE',
      meter_reading: b.meter_reading }, req.user.user_id));
    res.json({ battery_status: 'IN_SERVICE', from_asset_id: bat.current_asset_id, current_asset_id: Number(b.asset_id), ...out });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Return from a vehicle to the store.
router.post('/:id/return', requirePerm('BATTERY.ISSUE'), async (req, res) => {
  try {
    const id = Number(req.params.id); const b = req.body || {};
    const bat = await load(id);
    if (!bat) return res.status(404).json({ error: 'Battery not found' });
    if (bat.battery_status !== 'IN_SERVICE') return res.status(409).json({ error: 'battery is not in service' });
    const loc = b.location_id || bat.site_id;
    const out = await tx((c) => moveBattery(c, bat, { event_type: 'RETURNED', event_date: b.event_date || today(),
      from_asset_id: bat.current_asset_id, to_location_id: loc, to_status: 'IN_STOCK', remarks: b.reason }, req.user.user_id));
    res.json({ battery_status: 'IN_STOCK', ...out });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Scrap / write off.
router.post('/:id/scrap', requirePerm('BATTERY.WRITE'), async (req, res) => {
  try {
    const id = Number(req.params.id); const b = req.body || {};
    const bat = await load(id);
    if (!bat) return res.status(404).json({ error: 'Battery not found' });
    if (bat.battery_status === 'SCRAPPED') return res.status(409).json({ error: 'already scrapped' });
    const out = await tx((c) => moveBattery(c, bat, { event_type: 'SCRAPPED', event_date: b.event_date || today(),
      from_asset_id: bat.current_asset_id, to_status: 'SCRAPPED', remarks: b.reason }, req.user.user_id));
    res.json({ battery_status: 'SCRAPPED', ...out });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
