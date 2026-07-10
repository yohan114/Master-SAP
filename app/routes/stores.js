// Stores module — receive (GRN), issue, and the moving-average stock ledger.
// This is where "one system" is proved: an issue can post straight to a workshop
// job card, so real material cost flows into the job's final cost.
const express = require('express');
const { q, one, tx } = require('../db');
const { requirePerm, scopeSql } = require('../auth/mw');
const { nextNo } = require('../lib/numbering');

const router = express.Router();
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const qty4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;

async function siteCodeOf(locationId, c) {
  const r = c ? (await c.query('SELECT site_code, location_code FROM md_location WHERE location_id=$1', [locationId])).rows[0]
              : await one('SELECT site_code, location_code FROM md_location WHERE location_id=$1', [locationId]);
  return (r && (r.site_code || r.location_code || 'HQ')).trim().slice(0, 3).toUpperCase();
}

// current balance row for (item, location) or a zeroed default
async function balanceOf(c, itemId, locationId) {
  const r = (await c.query('SELECT * FROM inv_stock_balance WHERE item_id=$1 AND location_id=$2', [itemId, locationId])).rows[0];
  return r || { on_hand_qty: 0, stock_value: 0, moving_avg_cost: 0, _new: true };
}

// ---- item master + stock views -------------------------------------------
router.get('/items', async (req, res) => {
  try {
    const rows = await q(`SELECT item_id, item_no, item_name, item_type, base_uom_id FROM md_item
      WHERE is_active ORDER BY item_no LIMIT 500`);
    res.json({ count: rows.length, rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/stock', async (req, res) => {
  try {
    const sc = scopeSql(req, 'b', 1);   // inv_stock_balance has no site_id; scope via location's site
    const rows = await q(`SELECT b.item_id, i.item_no, i.item_name, b.location_id,
        b.on_hand_qty, b.moving_avg_cost, b.stock_value
      FROM inv_stock_balance b JOIN md_item i ON i.item_id=b.item_id
      JOIN md_location l ON l.location_id=b.location_id
      WHERE b.on_hand_qty <> 0 ${sc.sql ? sc.sql.replace('b.site_id', 'l.site_id') : ''}
      ORDER BY i.item_no`, sc.params);
    res.json({ count: rows.length, rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- receive (GRN) --------------------------------------------------------
// Posts an IN movement and rolls the moving-average cost forward.
router.post('/receive', requirePerm('STORES.RECEIVE'), async (req, res) => {
  try {
    const b = req.body || {};
    const { item_id, location_id, qty, unit_cost = 0, movement_date = new Date().toISOString().slice(0, 10) } = b;
    if (!item_id || !location_id || !(qty > 0)) return res.status(400).json({ error: 'item_id, location_id, qty>0 required' });
    const site_id = b.site_id || location_id;
    const out = await tx(async (c) => {
      const bal = await balanceOf(c, item_id, location_id);
      const newQty = qty4(Number(bal.on_hand_qty) + Number(qty));
      const newVal = money(Number(bal.stock_value) + qty * unit_cost);
      const newAvg = newQty > 0 ? Math.round((newVal / newQty) * 10000) / 10000 : 0;
      const scode = await siteCodeOf(site_id, c);
      const item = (await c.query('SELECT base_uom_id FROM md_item WHERE item_id=$1', [item_id])).rows[0];
      const supplier = b.supplier_id
        ? { supplier_id: b.supplier_id }
        : (await c.query('SELECT supplier_id FROM md_supplier WHERE is_active ORDER BY supplier_id LIMIT 1')).rows[0];
      if (!supplier) throw new Error('no supplier on file — seed a supplier first');

      // Goods-received note (header + line) — the source document for the movement
      const grnNo = await nextNo('GRN', scode, movement_date, c);
      const grn = (await c.query(
        `INSERT INTO tx_grn(grn_no, grn_date, supplier_id, location_id, total_qty, total_amt,
             grn_status, doc_status, site_id, created_by)
         VALUES($1,$2,$3,$4,$5,$6,'POSTED','POSTED',$7,$8) RETURNING grn_id`,
        [grnNo, movement_date, supplier.supplier_id, location_id, qty, money(qty * unit_cost), site_id, req.user.user_id])).rows[0];
      const grnLine = (await c.query(
        `INSERT INTO txl_grn(grn_id, line_no, item_id, uom_id, received_qty, accepted_qty, unit_price,
             line_amt, is_priced, price_status, created_by)
         VALUES($1,1,$2,$3,$4,$4,$5,$6,TRUE,'CONFIRMED',$7) RETURNING grn_line_id`,
        [grn.grn_id, item_id, item.base_uom_id, qty, unit_cost, money(qty * unit_cost), req.user.user_id])).rows[0];

      const mno = await nextNo('MOV', scode, movement_date, c);
      const led = (await c.query(
        `INSERT INTO mv_stock_ledger(movement_no, movement_date, item_id, location_id, mv_direction,
             qty, unit_cost, value_amt, running_balance_qty, running_balance_value, running_avg_cost,
             source_doc_type, source_doc_id, source_line_id, posted_by, posted_at, site_id, created_by)
         VALUES($1,$2,$3,$4,'IN',$5,$6,$7,$8,$9,$10,'GRN',$11,$12,$13,now(),$14,$13) RETURNING ledger_id`,
        [mno, movement_date, item_id, location_id, qty, unit_cost, money(qty * unit_cost),
         newQty, newVal, newAvg, grn.grn_id, grnLine.grn_line_id, req.user.user_id, site_id])).rows[0];
      await c.query('UPDATE txl_grn SET ledger_id=$1 WHERE grn_line_id=$2', [led.ledger_id, grnLine.grn_line_id]);
      await c.query(
        `INSERT INTO inv_stock_balance(item_id, location_id, on_hand_qty, moving_avg_cost, stock_value,
             last_movement_id, last_movement_at, last_receipt_date, created_by)
         VALUES($1,$2,$3,$4,$5,$6,now(),$7,$8)
         ON CONFLICT (item_id, location_id) DO UPDATE SET on_hand_qty=$3, moving_avg_cost=$4,
             stock_value=$5, last_movement_id=$6, last_movement_at=now(), last_receipt_date=$7,
             updated_by=$8, updated_at=now()`,
        [item_id, location_id, newQty, newAvg, newVal, led.ledger_id, movement_date, req.user.user_id]);
      return { on_hand_qty: newQty, moving_avg_cost: newAvg, stock_value: newVal, ledger_id: led.ledger_id };
    });
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- issue (optionally straight to a job card) ----------------------------
router.post('/issue', requirePerm('STORES.ISSUE'), async (req, res) => {
  try {
    const b = req.body || {};
    const { item_id, location_id, qty, jobcard_id = null, asset_id = null,
            issue_date = new Date().toISOString().slice(0, 10) } = b;
    if (!item_id || !location_id || !(qty > 0)) return res.status(400).json({ error: 'item_id, location_id, qty>0 required' });
    const site_id = b.site_id || location_id;
    const out = await tx(async (c) => {
      const bal = await balanceOf(c, item_id, location_id);
      if (bal._new || Number(bal.on_hand_qty) < qty)
        throw new Error(`insufficient stock: on hand ${Number(bal.on_hand_qty) || 0}, requested ${qty}`);
      const avg = Number(bal.moving_avg_cost);
      const lineAmt = money(qty * avg);
      const newQty = qty4(Number(bal.on_hand_qty) - qty);
      const newVal = money(newQty * avg);
      const item = (await c.query('SELECT base_uom_id FROM md_item WHERE item_id=$1', [item_id])).rows[0];
      const scode = await siteCodeOf(site_id, c);

      // issue document + line
      const issNo = await nextNo('ISS', scode, issue_date, c);
      const iss = (await c.query(
        `INSERT INTO tx_issue(issue_no, issue_date, location_id, issue_type, asset_id, jobcard_id,
             total_amt, doc_status, site_id, created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,'POSTED',$8,$9) RETURNING issue_id`,
        [issNo, issue_date, location_id, jobcard_id ? 'JOB' : 'STORE', asset_id, jobcard_id, lineAmt, site_id, req.user.user_id])).rows[0];
      // ledger OUT (qty stored positive; direction carries the sign)
      const mno = await nextNo('MOV', scode, issue_date, c);
      const led = (await c.query(
        `INSERT INTO mv_stock_ledger(movement_no, movement_date, item_id, location_id, mv_direction,
             qty, unit_cost, value_amt, running_balance_qty, running_balance_value, running_avg_cost,
             source_doc_type, source_doc_id, posted_by, posted_at, site_id, created_by)
         VALUES($1,$2,$3,$4,'OUT',$5,$6,$7,$8,$9,$10,'ISSUE',$11,$12,now(),$13,$12) RETURNING ledger_id`,
        [mno, issue_date, item_id, location_id, qty, avg, lineAmt, newQty, newVal, avg, iss.issue_id, req.user.user_id, site_id])).rows[0];
      const issLine = (await c.query(
        `INSERT INTO txl_issue(issue_id, line_no, item_id, uom_id, issued_qty, unit_cost, line_amt, ledger_id, created_by)
         VALUES($1,1,$2,$3,$4,$5,$6,$7,$8) RETURNING issue_line_id`,
        [iss.issue_id, item_id, item.base_uom_id, qty, avg, lineAmt, led.ledger_id, req.user.user_id])).rows[0];
      await c.query(
        `UPDATE inv_stock_balance SET on_hand_qty=$1, stock_value=$2, last_movement_id=$3,
             last_movement_at=now(), last_issue_date=$4, updated_by=$5, updated_at=now()
         WHERE item_id=$6 AND location_id=$7`,
        [newQty, newVal, led.ledger_id, issue_date, req.user.user_id, item_id, location_id]);

      // THE UNIFICATION: post this issue as a part on the job card, at the issued cost
      let job_part_id = null;
      if (jobcard_id) {
        const jp = (await c.query(
          `INSERT INTO tx_job_parts(jobcard_id, item_id, uom_id, qty, unit_cost, part_cost,
               source_type, issue_line_id, ledger_id, site_id, created_by)
           VALUES($1,$2,$3,$4,$5,$6,'ISSUE',$7,$8,$9,$10) RETURNING job_part_id`,
          [jobcard_id, item_id, item.base_uom_id, qty, avg, lineAmt, issLine.issue_line_id, led.ledger_id, site_id, req.user.user_id])).rows[0];
        job_part_id = jp.job_part_id;
      }
      return { issue_no: issNo, issued_qty: qty, unit_cost: avg, line_amt: lineAmt,
        on_hand_qty: newQty, job_part_id };
    });
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
