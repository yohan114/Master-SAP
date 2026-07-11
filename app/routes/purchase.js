// Procurement — Local & Head-Office purchase orders → receive (GRN) → pending-price → confirm.
// A PO orders stock (priced now, or price-on-receipt). Receiving posts an IN movement per line at
// the shared MWAC engine: priced lines value immediately; unpriced lines come in at a provisional
// cost (last MWAC) and raise an inv_pending_price row. Confirming the price revalues the stock
// (a REVAL ledger movement for the variance) so valuation catches up — core rule #6 (effective price)
// and the "pending price update tracking" requirement.
const express = require('express');
const { q, one, tx } = require('../db');
const { requirePerm, scopeSql } = require('../auth/mw');
const { nextNo } = require('../lib/numbering');
const { balanceOf, upsertBalance, siteCodeOf, avg4, money, qty4 } = require('../lib/inventory');

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

// ---- Purchase orders --------------------------------------------------------

router.get('/po', async (req, res) => {
  try {
    const sc = scopeSql(req, 'p', 1);
    const rows = await q(
      `SELECT p.po_id, p.po_no, p.po_date, p.po_type, p.doc_status, p.total_amt, p.mrn_id,
              s.supplier_name, l.location_name AS deliver_to,
              (SELECT count(*) FROM txl_po x WHERE x.po_id=p.po_id AND x.is_active) AS lines
       FROM tx_po p JOIN md_supplier s ON s.supplier_id=p.supplier_id
       JOIN md_location l ON l.location_id=p.location_id
       WHERE p.is_active${sc.sql} ORDER BY p.po_id DESC LIMIT 200`, sc.params);
    res.json({ count: rows.length, rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/po/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const sc = scopeSql(req, 'p', 2);
    const po = await one(
      `SELECT p.*, s.supplier_name, l.location_name AS deliver_to
       FROM tx_po p JOIN md_supplier s ON s.supplier_id=p.supplier_id
       JOIN md_location l ON l.location_id=p.location_id
       WHERE p.po_id=$1${sc.sql}`, [id, ...sc.params]);
    if (!po) return res.status(404).json({ error: 'PO not found' });
    po.lines = await q(
      `SELECT x.po_line_id, x.line_no, x.item_id, i.item_no, i.item_name, u.uom_code,
              x.order_qty, x.received_qty, x.unit_price, x.line_amt, x.line_status
       FROM txl_po x JOIN md_item i ON i.item_id=x.item_id JOIN md_uom u ON u.uom_id=x.uom_id
       WHERE x.po_id=$1 AND x.is_active ORDER BY x.line_no`, [id]);
    res.json(po);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Raise a PO. po_type LOCAL | HEAD_OFFICE. Lines may carry a unit_price now, or leave it blank
// for price-on-receipt. Optionally raised from an approved MRN (links mrn_id, sets MRN line po_qty).
router.post('/po', requirePerm('STORES.PO'), async (req, res) => {
  try {
    const b = req.body || {};
    const type = String(b.po_type || 'LOCAL').toUpperCase();
    if (!['LOCAL', 'HEAD_OFFICE'].includes(type)) return res.status(400).json({ error: 'po_type must be LOCAL or HEAD_OFFICE' });
    if (!b.location_id) return res.status(400).json({ error: 'location_id (deliver-to store) required' });
    const lines = Array.isArray(b.lines) ? b.lines.filter((x) => x && x.item_id && Number(x.order_qty) > 0) : [];
    if (!lines.length) return res.status(400).json({ error: 'at least one line (item_id + order_qty>0) required' });
    const uid = req.user.user_id;
    const date = b.po_date || today();
    const siteId = b.site_id || await siteIdOf(b.location_id);
    const supplier = b.supplier_id
      ? { supplier_id: b.supplier_id }
      : await one('SELECT supplier_id FROM md_supplier WHERE is_active ORDER BY supplier_id LIMIT 1');
    if (!supplier) return res.status(400).json({ error: 'no supplier on file — add a supplier first' });
    const out = await tx(async (c) => {
      const no = await nextNo('PO', await siteCodeOf(c, siteId), date, c);
      const po = (await c.query(
        `INSERT INTO tx_po(po_no, po_date, po_type, supplier_id, location_id, mrn_id, doc_status, site_id, created_by)
         VALUES($1,$2,$3,$4,$5,$6,'DRAFT',$7,$8) RETURNING po_id, po_no, doc_status`,
        [no, date, type, supplier.supplier_id, b.location_id, b.mrn_id || null, siteId, uid])).rows[0];
      let ln = 0, total = 0;
      for (const line of lines) {
        const item = (await c.query('SELECT base_uom_id FROM md_item WHERE item_id=$1', [line.item_id])).rows[0];
        if (!item) throw new Error(`unknown item ${line.item_id}`);
        const price = money(line.unit_price || 0);
        const amt = money(Number(line.order_qty) * price);
        await c.query(
          `INSERT INTO txl_po(po_id, line_no, item_id, uom_id, order_qty, unit_price, line_amt, mrn_line_id, created_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [po.po_id, ++ln, line.item_id, item.base_uom_id, qty4(line.order_qty), price, amt, line.mrn_line_id || null, uid]);
        if (line.mrn_line_id) await c.query('UPDATE txl_mrn SET po_qty=$1, updated_by=$2, updated_at=now() WHERE mrn_line_id=$3', [qty4(line.order_qty), uid, line.mrn_line_id]);
        total += amt;
      }
      await c.query('UPDATE tx_po SET total_amt=$1 WHERE po_id=$2', [money(total), po.po_id]);
      return { ...po, lines: ln, total_amt: money(total) };
    });
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/po/:id/approve', requirePerm('STORES.PO'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const po = await one('SELECT po_id, doc_status FROM tx_po WHERE po_id=$1 AND is_active', [id]);
    if (!po) return res.status(404).json({ error: 'PO not found' });
    if (po.doc_status !== 'DRAFT') return res.status(409).json({ error: `PO is ${po.doc_status}; only a DRAFT can be approved` });
    await q("UPDATE tx_po SET doc_status='APPROVED', approved_by=$1, approved_at=now(), updated_by=$1, updated_at=now() WHERE po_id=$2", [req.user.user_id, id]);
    res.json({ po_id: id, doc_status: 'APPROVED' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Receive against a PO into a GRN. Body.lines = [{po_line_id, qty, unit_price?}] or omit to receive
// every remaining line in full. Priced lines value at their price; unpriced lines come in at the last
// moving-average cost (provisional) and raise a pending-price row.
router.post('/po/:id/receive', requirePerm('STORES.RECEIVE'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const b = req.body || {};
    const uid = req.user.user_id;
    const date = b.grn_date || today();
    const po = await one('SELECT * FROM tx_po WHERE po_id=$1 AND is_active', [id]);
    if (!po) return res.status(404).json({ error: 'PO not found' });
    if (!['APPROVED', 'PARTIAL'].includes(po.doc_status)) return res.status(409).json({ error: `PO is ${po.doc_status}; approve it before receiving` });
    const want = new Map(Array.isArray(b.lines) ? b.lines.map((x) => [Number(x.po_line_id), x]) : []);
    const out = await tx(async (c) => {
      const scode = await siteCodeOf(c, po.site_id);
      const grn = (await c.query(
        `INSERT INTO tx_grn(grn_no, grn_date, po_id, supplier_id, location_id, grn_status, doc_status, site_id, created_by)
         VALUES($1,$2,$3,$4,$5,'RECEIVED','POSTED',$6,$7) RETURNING grn_id, grn_no`,
        [await nextNo('GRN', scode, date, c), date, id, po.supplier_id, po.location_id, po.site_id, uid])).rows[0];
      const polines = (await c.query('SELECT * FROM txl_po WHERE po_id=$1 AND is_active ORDER BY line_no', [id])).rows;
      let lineNo = 0, totQty = 0, totAmt = 0; const posted = [];
      for (const pl of polines) {
        const remaining = qty4(Number(pl.order_qty) - Number(pl.received_qty));
        if (!(remaining > 0)) continue;
        let rq = remaining, override;
        if (want.size) { const w = want.get(pl.po_line_id); if (!w) continue; rq = qty4(Math.min(Number(w.qty), remaining)); override = w.unit_price; }
        if (!(rq > 0)) continue;
        const knownPrice = override != null ? money(override) : Number(pl.unit_price) || 0;
        const priced = knownPrice > 0;
        const bal = await balanceOf(c, pl.item_id, po.location_id);
        const provCost = priced ? knownPrice : (Number(bal.moving_avg_cost) || 0);
        const newQty = qty4(Number(bal.on_hand_qty) + rq);
        const addVal = money(rq * provCost);
        const newVal = money(Number(bal.stock_value) + addVal);
        const newAvg = avg4(newVal, newQty);
        const led = (await c.query(
          `INSERT INTO mv_stock_ledger(movement_no, movement_date, item_id, location_id, mv_direction, qty, unit_cost, value_amt,
               running_balance_qty, running_balance_value, running_avg_cost, source_doc_type, source_doc_id, posted_by, posted_at, site_id, created_by)
           VALUES($1,$2,$3,$4,'IN',$5,$6,$7,$8,$9,$10,'GRN',$11,$12,now(),$13,$12) RETURNING ledger_id`,
          [await nextNo('MOV', scode, date, c), date, pl.item_id, po.location_id, rq, provCost, addVal, newQty, newVal, newAvg, grn.grn_id, uid, po.site_id])).rows[0];
        const gl = (await c.query(
          `INSERT INTO txl_grn(grn_id, line_no, item_id, uom_id, ordered_qty, received_qty, accepted_qty, unit_price, line_amt,
               is_priced, price_status, po_line_id, ledger_id, created_by)
           VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING grn_line_id`,
          [grn.grn_id, ++lineNo, pl.item_id, pl.uom_id, pl.order_qty, rq, priced ? knownPrice : null, priced ? addVal : 0,
           priced, priced ? 'CONFIRMED' : 'PENDING', pl.po_line_id, led.ledger_id, uid])).rows[0];
        await upsertBalance(c, pl.item_id, po.location_id, { on_hand_qty: newQty, moving_avg_cost: newAvg, stock_value: newVal, last_movement_id: led.ledger_id }, uid);
        const recvNow = qty4(Number(pl.received_qty) + rq);
        await c.query('UPDATE txl_po SET received_qty=$1, line_status=$2, updated_by=$3, updated_at=now() WHERE po_line_id=$4',
          [recvNow, recvNow >= Number(pl.order_qty) ? 'CLOSED' : 'PARTIAL', uid, pl.po_line_id]);
        let pending_id = null;
        if (!priced) {
          pending_id = (await c.query(
            `INSERT INTO inv_pending_price(grn_id, grn_line_id, item_id, location_id, received_qty, provisional_unit_cost,
                 provisional_source, price_status, site_id, created_by)
             VALUES($1,$2,$3,$4,$5,$6,$7,'PENDING',$8,$9) RETURNING pending_id`,
            [grn.grn_id, gl.grn_line_id, pl.item_id, po.location_id, rq, provCost, provCost > 0 ? 'LAST' : 'PO', po.site_id, uid])).rows[0].pending_id;
        }
        totQty += rq; totAmt += addVal;
        posted.push({ po_line_id: pl.po_line_id, item_id: pl.item_id, received: rq, priced, unit_cost: provCost, pending_id });
      }
      await c.query('UPDATE tx_grn SET total_qty=$1, total_amt=$2 WHERE grn_id=$3', [qty4(totQty), money(totAmt), grn.grn_id]);
      const after = (await c.query('SELECT order_qty, received_qty FROM txl_po WHERE po_id=$1 AND is_active', [id])).rows;
      const allDone = after.every((l) => Number(l.received_qty) >= Number(l.order_qty));
      const anyRecv = after.some((l) => Number(l.received_qty) > 0);
      const doc_status = allDone ? 'RECEIVED' : anyRecv ? 'PARTIAL' : po.doc_status;
      await c.query('UPDATE tx_po SET doc_status=$1, updated_by=$2, updated_at=now() WHERE po_id=$3', [doc_status, uid, id]);
      return { grn_id: grn.grn_id, grn_no: grn.grn_no, po_status: doc_status, lines: posted };
    });
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- Pending price tracking -------------------------------------------------

router.get('/pending', async (req, res) => {
  try {
    const sc = scopeSql(req, 'p', 1);
    const rows = await q(
      `SELECT p.pending_id, p.item_id, i.item_no, i.item_name, l.location_code, p.received_qty,
              p.provisional_unit_cost, p.provisional_source, p.price_status, g.grn_no
       FROM inv_pending_price p JOIN md_item i ON i.item_id=p.item_id
       JOIN md_location l ON l.location_id=p.location_id
       JOIN tx_grn g ON g.grn_id=p.grn_id
       WHERE p.is_active AND p.price_status<>'CONFIRMED'${sc.sql}
       ORDER BY p.pending_id DESC LIMIT 200`, sc.params);
    res.json({ count: rows.length, rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Confirm the price of a pending receipt → revalue the stock by the variance (a REVAL ledger row).
router.post('/pending/:id/confirm', requirePerm('STORES.PRICE'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const b = req.body || {};
    const cost = money(b.unit_cost);
    if (!(cost > 0)) return res.status(400).json({ error: 'unit_cost > 0 required' });
    const p = await one('SELECT * FROM inv_pending_price WHERE pending_id=$1 AND is_active', [id]);
    if (!p) return res.status(404).json({ error: 'pending-price record not found' });
    if (p.price_status === 'CONFIRMED') return res.status(409).json({ error: 'already confirmed' });
    const uid = req.user.user_id;
    const out = await tx(async (c) => {
      const prov = Number(p.provisional_unit_cost);
      const qty = Number(p.received_qty);
      const delta = money((cost - prov) * qty);
      const bal = await balanceOf(c, p.item_id, p.location_id);
      const onHand = qty4(Number(bal.on_hand_qty) || 0);
      const newVal = money(Number(bal.stock_value) + delta);
      const newAvg = onHand > 0 ? avg4(newVal, onHand) : cost;
      const scode = await siteCodeOf(c, p.site_id);
      const led = (await c.query(
        `INSERT INTO mv_stock_ledger(movement_no, movement_date, item_id, location_id, mv_direction, qty, unit_cost, value_amt,
             running_balance_qty, running_balance_value, running_avg_cost, source_doc_type, source_doc_id, posted_by, posted_at, site_id, created_by)
         VALUES($1,CURRENT_DATE,$2,$3,$4,0,0,$5,$6,$7,$8,'REVAL',$9,$10,now(),$11,$10) RETURNING ledger_id`,
        [await nextNo('MOV', scode, new Date().toISOString(), c), p.item_id, p.location_id,
         delta >= 0 ? 'ADJ_IN' : 'ADJ_OUT', money(Math.abs(delta)), onHand, newVal, newAvg, id, uid, p.site_id])).rows[0];
      await upsertBalance(c, p.item_id, p.location_id, { on_hand_qty: onHand, moving_avg_cost: newAvg, stock_value: newVal, last_movement_id: led.ledger_id }, uid);
      await c.query("UPDATE txl_grn SET unit_price=$1, line_amt=$2, is_priced=TRUE, price_status='CONFIRMED', updated_by=$3, updated_at=now() WHERE grn_line_id=$4",
        [cost, money(qty * cost), uid, p.grn_line_id]);
      await c.query("UPDATE inv_pending_price SET price_status='CONFIRMED', confirmed_unit_cost=$1, variance_amt=$2, reval_ledger_id=$3, resolved_by=$4, resolved_at=now(), updated_by=$4, updated_at=now() WHERE pending_id=$5",
        [cost, delta, led.ledger_id, uid, id]);
      return { pending_id: id, confirmed_unit_cost: cost, variance_amt: delta, new_avg_cost: newAvg, on_hand: onHand };
    });
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
