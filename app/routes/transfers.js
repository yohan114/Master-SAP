// Material transfers between locations (core rule #7). A posted transfer reduces stock at the
// source and increases it at the destination, each an append-only ledger movement under one
// tx_transfer document — reusing the shared inventory engine so valuation stays consistent.
const express = require('express');
const { q, one, tx } = require('../db');
const { requirePerm, scopeSql } = require('../auth/mw');
const { postTransfer } = require('../lib/inventory');

const router = express.Router();
const today = () => new Date().toISOString().slice(0, 10);

// The SITE a location belongs to (a SITE-type location sharing its site_code); falls back to itself.
async function siteIdOf(locId) {
  const loc = await one('SELECT location_id, site_code, location_type FROM md_location WHERE location_id=$1', [locId]);
  if (!loc) return locId;
  if (loc.location_type === 'SITE') return loc.location_id;
  const site = await one("SELECT location_id FROM md_location WHERE location_type='SITE' AND site_code=$1 LIMIT 1", [loc.site_code]);
  return site ? site.location_id : loc.location_id;
}

// List transfers (site-scoped).
router.get('/', async (req, res) => {
  try {
    const sc = scopeSql(req, 't', 1);
    const rows = await q(
      `SELECT t.transfer_id, t.transfer_no, t.transfer_date, t.from_location_id, t.to_location_id,
              fl.location_name AS from_name, tl.location_name AS to_name, t.total_amt, t.doc_status,
              (SELECT count(*) FROM txl_transfer x WHERE x.transfer_id=t.transfer_id) AS lines
       FROM tx_transfer t
       JOIN md_location fl ON fl.location_id=t.from_location_id
       JOIN md_location tl ON tl.location_id=t.to_location_id
       WHERE t.is_active${sc.sql} ORDER BY t.transfer_id DESC LIMIT 200`, sc.params);
    res.json({ count: rows.length, rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// One transfer with its line(s).
router.get('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const sc = scopeSql(req, 't', 2);
    const t = await one(
      `SELECT t.*, fl.location_name AS from_name, tl.location_name AS to_name
       FROM tx_transfer t JOIN md_location fl ON fl.location_id=t.from_location_id
       JOIN md_location tl ON tl.location_id=t.to_location_id
       WHERE t.transfer_id=$1${sc.sql}`, [id, ...sc.params]);
    if (!t) return res.status(404).json({ error: 'Transfer not found' });
    t.lines = await q(
      `SELECT x.line_no, x.item_id, i.item_no, i.item_name, x.transfer_qty, x.unit_cost, x.line_amt
       FROM txl_transfer x JOIN md_item i ON i.item_id=x.item_id
       WHERE x.transfer_id=$1 ORDER BY x.line_no`, [id]);
    res.json(t);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Post a transfer (source -> destination) at the source's moving-average cost.
router.post('/', requirePerm('STORES.TRANSFER'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.item_id || !b.from_location_id || !b.to_location_id || !(b.qty > 0))
      return res.status(400).json({ error: 'item_id, from_location_id, to_location_id, qty>0 required' });
    if (Number(b.from_location_id) === Number(b.to_location_id))
      return res.status(400).json({ error: 'source and destination must differ' });
    const siteId = b.site_id || await siteIdOf(b.from_location_id);
    const out = await tx((c) => postTransfer(c, {
      itemId: b.item_id, fromLoc: b.from_location_id, toLoc: b.to_location_id, qty: b.qty,
      date: b.transfer_date || today(), siteId, userId: req.user.user_id,
    }));
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
