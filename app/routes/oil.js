// Oil / Lubricant module. Lubricants are stock like any other item, so receive/issue
// reuse the shared inventory engine (same MWAC ledger). What's oil-specific: issues are
// consumed BY a vehicle/machine, so we track consumption-by-asset and run book-vs-physical
// counts on the oil book. An oil issue can post to a job card exactly like a stores issue.
const express = require('express');
const { q, one, tx } = require('../db');
const { requirePerm, scopeSql } = require('../auth/mw');
const { postReceive, postIssue, postCount } = require('../lib/inventory');

const router = express.Router();
const today = () => new Date().toISOString().slice(0, 10);
const isLube = async (itemId) => {
  const r = await one("SELECT 1 FROM md_item WHERE item_id=$1 AND item_type='LUBRICANT'", [itemId]);
  return !!r;
};

// Lubricant products + current stock.
router.get('/products', async (req, res) => {
  try {
    const rows = await q(`SELECT i.item_id, i.item_no, i.item_name, i.base_uom_id,
        COALESCE(b.on_hand_qty,0) AS on_hand_qty, COALESCE(b.moving_avg_cost,0) AS moving_avg_cost,
        COALESCE(b.stock_value,0) AS stock_value
      FROM md_item i LEFT JOIN inv_stock_balance b ON b.item_id=i.item_id
      WHERE i.is_active AND i.item_type='LUBRICANT' ORDER BY i.item_no`);
    res.json({ count: rows.length, rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Receive lubricant stock (GRN).
router.post('/receive', requirePerm('OIL.RECEIVE'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.item_id || !b.location_id || !(b.qty > 0)) return res.status(400).json({ error: 'item_id, location_id, qty>0 required' });
    if (!(await isLube(b.item_id))) return res.status(400).json({ error: 'item is not a LUBRICANT' });
    const out = await tx((c) => postReceive(c, { itemId: b.item_id, locationId: b.location_id, qty: b.qty,
      unitCost: b.unit_cost || 0, date: b.movement_date || today(), siteId: b.site_id || b.location_id,
      userId: req.user.user_id, supplierId: b.supplier_id }));
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Issue lubricant TO a vehicle/machine (asset_id required) — and optionally onto a job card.
router.post('/issue', requirePerm('OIL.ISSUE'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.item_id || !b.location_id || !(b.qty > 0) || !b.asset_id)
      return res.status(400).json({ error: 'item_id, location_id, qty>0, asset_id required' });
    if (!(await isLube(b.item_id))) return res.status(400).json({ error: 'item is not a LUBRICANT' });
    const out = await tx((c) => postIssue(c, { itemId: b.item_id, locationId: b.location_id, qty: b.qty,
      assetId: b.asset_id, jobcardId: b.jobcard_id || null, date: b.issue_date || today(),
      siteId: b.site_id || b.location_id, userId: req.user.user_id }));
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Consumption by asset — litres + value of each lubricant issued per vehicle in a date range.
router.get('/consumption', async (req, res) => {
  try {
    const from = req.query.from || '1900-01-01';
    const to = req.query.to || '2999-12-31';
    const sc = scopeSql(req, 'g', 3);
    const rows = await q(`SELECT a.asset_no, a.asset_name, i.item_no, i.item_name,
        SUM(g.qty) AS qty_issued, SUM(g.value_amt) AS value_issued, COUNT(*) AS issue_count
      FROM mv_stock_ledger g
      JOIN md_item i  ON i.item_id=g.item_id AND i.item_type='LUBRICANT'
      JOIN tx_issue t ON t.issue_id=g.source_doc_id AND g.source_doc_type='ISSUE'
      JOIN md_asset a ON a.asset_id=t.asset_id
      WHERE g.mv_direction='OUT' AND g.movement_date BETWEEN $1 AND $2 ${sc.sql}
      GROUP BY a.asset_no, a.asset_name, i.item_no, i.item_name
      ORDER BY value_issued DESC`, [from, to, ...sc.params]);
    res.json({ count: rows.length, rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Physical stock count on a lubricant -> variance vs the book, with optional auto-adjust.
router.post('/count', requirePerm('OIL.COUNT'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.item_id || !b.location_id || b.counted_qty == null) return res.status(400).json({ error: 'item_id, location_id, counted_qty required' });
    if (!(await isLube(b.item_id))) return res.status(400).json({ error: 'item is not a LUBRICANT' });
    const out = await tx((c) => postCount(c, { itemId: b.item_id, locationId: b.location_id,
      countedQty: b.counted_qty, date: b.count_date || today(), siteId: b.site_id || b.location_id,
      userId: req.user.user_id, reason: b.reason || 'COUNT' }));
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
