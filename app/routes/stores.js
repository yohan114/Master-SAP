// Stores module — item master, stock views, receive, issue. The stock mechanics live
// in lib/inventory.js (shared with oil); these handlers just gate + validate + call it.
const express = require('express');
const { q, tx } = require('../db');
const { requirePerm, scopeSql } = require('../auth/mw');
const { postReceive, postIssue } = require('../lib/inventory');

const router = express.Router();
const today = () => new Date().toISOString().slice(0, 10);

router.get('/items', async (req, res) => {
  try {
    const rows = await q(`SELECT item_id, item_no, item_name, item_type, base_uom_id FROM md_item
      WHERE is_active AND item_type <> 'LUBRICANT' ORDER BY item_no LIMIT 500`);
    res.json({ count: rows.length, rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/stock', async (req, res) => {
  try {
    const sc = scopeSql(req, 'l', 1);
    const rows = await q(`SELECT b.item_id, i.item_no, i.item_name, b.location_id,
        b.on_hand_qty, b.moving_avg_cost, b.stock_value
      FROM inv_stock_balance b JOIN md_item i ON i.item_id=b.item_id
      JOIN md_location l ON l.location_id=b.location_id
      WHERE b.on_hand_qty <> 0 AND i.item_type <> 'LUBRICANT'
      ${sc.sql} ORDER BY i.item_no`, sc.params);
    res.json({ count: rows.length, rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/receive', requirePerm('STORES.RECEIVE'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.item_id || !b.location_id || !(b.qty > 0)) return res.status(400).json({ error: 'item_id, location_id, qty>0 required' });
    const out = await tx((c) => postReceive(c, {
      itemId: b.item_id, locationId: b.location_id, qty: b.qty, unitCost: b.unit_cost || 0,
      date: b.movement_date || today(), siteId: b.site_id || b.location_id, userId: req.user.user_id, supplierId: b.supplier_id,
    }));
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/issue', requirePerm('STORES.ISSUE'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.item_id || !b.location_id || !(b.qty > 0)) return res.status(400).json({ error: 'item_id, location_id, qty>0 required' });
    const out = await tx((c) => postIssue(c, {
      itemId: b.item_id, locationId: b.location_id, qty: b.qty, jobcardId: b.jobcard_id || null,
      assetId: b.asset_id || null, date: b.issue_date || today(), siteId: b.site_id || b.location_id, userId: req.user.user_id,
    }));
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
