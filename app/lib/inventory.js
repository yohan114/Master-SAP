// Shared inventory engine used by every stock module (stores, oil, …).
// One moving-average ledger, one issue/receipt/adjustment path — so stores and oil
// are genuinely the same system, not two implementations. All functions take an open
// transaction client `c` and post append-only movements against mv_stock_ledger.
const { nextNo } = require('./numbering');

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const qty4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
const avg4 = (v, q) => (q > 0 ? Math.round((v / q) * 10000) / 10000 : 0);

async function siteCodeOf(c, locationId) {
  const r = (await c.query('SELECT site_code, location_code FROM md_location WHERE location_id=$1', [locationId])).rows[0];
  return (r && (r.site_code || r.location_code || 'HQ')).trim().slice(0, 3).toUpperCase();
}
async function balanceOf(c, itemId, locationId) {
  const r = (await c.query('SELECT * FROM inv_stock_balance WHERE item_id=$1 AND location_id=$2', [itemId, locationId])).rows[0];
  return r || { on_hand_qty: 0, stock_value: 0, moving_avg_cost: 0, _new: true };
}
async function upsertBalance(c, itemId, locationId, patch, userId) {
  const cols = Object.keys(patch);
  await c.query(
    `INSERT INTO inv_stock_balance(item_id, location_id, on_hand_qty, moving_avg_cost, stock_value, last_movement_id, last_movement_at, created_by)
       VALUES($1,$2,$3,$4,$5,$6,now(),$7)
     ON CONFLICT (item_id, location_id) DO UPDATE SET on_hand_qty=$3, moving_avg_cost=$4, stock_value=$5,
       last_movement_id=$6, last_movement_at=now(), updated_by=$7, updated_at=now()`,
    [itemId, locationId, patch.on_hand_qty, patch.moving_avg_cost, patch.stock_value, patch.last_movement_id, userId]);
  void cols;
}

// Receive stock via a GRN; rolls the moving-average cost forward.
async function postReceive(c, { itemId, locationId, qty, unitCost = 0, date, siteId, userId, supplierId }) {
  if (!(qty > 0)) throw new Error('qty must be > 0');
  const bal = await balanceOf(c, itemId, locationId);
  const newQty = qty4(Number(bal.on_hand_qty) + Number(qty));
  const newVal = money(Number(bal.stock_value) + qty * unitCost);
  const newAvg = avg4(newVal, newQty);
  const scode = await siteCodeOf(c, siteId);
  const item = (await c.query('SELECT base_uom_id FROM md_item WHERE item_id=$1', [itemId])).rows[0];
  const supplier = supplierId
    ? { supplier_id: supplierId }
    : (await c.query('SELECT supplier_id FROM md_supplier WHERE is_active ORDER BY supplier_id LIMIT 1')).rows[0];
  if (!supplier) throw new Error('no supplier on file — seed a supplier first');

  const grn = (await c.query(
    `INSERT INTO tx_grn(grn_no, grn_date, supplier_id, location_id, total_qty, total_amt, grn_status, doc_status, site_id, created_by)
     VALUES($1,$2,$3,$4,$5,$6,'POSTED','POSTED',$7,$8) RETURNING grn_id`,
    [await nextNo('GRN', scode, date, c), date, supplier.supplier_id, locationId, qty, money(qty * unitCost), siteId, userId])).rows[0];
  const grnLine = (await c.query(
    `INSERT INTO txl_grn(grn_id, line_no, item_id, uom_id, received_qty, accepted_qty, unit_price, line_amt, is_priced, price_status, created_by)
     VALUES($1,1,$2,$3,$4,$4,$5,$6,TRUE,'CONFIRMED',$7) RETURNING grn_line_id`,
    [grn.grn_id, itemId, item.base_uom_id, qty, unitCost, money(qty * unitCost), userId])).rows[0];
  const led = (await c.query(
    `INSERT INTO mv_stock_ledger(movement_no, movement_date, item_id, location_id, mv_direction, qty, unit_cost, value_amt,
         running_balance_qty, running_balance_value, running_avg_cost, source_doc_type, source_doc_id, source_line_id, posted_by, posted_at, site_id, created_by)
     VALUES($1,$2,$3,$4,'IN',$5,$6,$7,$8,$9,$10,'GRN',$11,$12,$13,now(),$14,$13) RETURNING ledger_id`,
    [await nextNo('MOV', scode, date, c), date, itemId, locationId, qty, unitCost, money(qty * unitCost),
     newQty, newVal, newAvg, grn.grn_id, grnLine.grn_line_id, userId, siteId])).rows[0];
  await c.query('UPDATE txl_grn SET ledger_id=$1 WHERE grn_line_id=$2', [led.ledger_id, grnLine.grn_line_id]);
  await upsertBalance(c, itemId, locationId, { on_hand_qty: newQty, moving_avg_cost: newAvg, stock_value: newVal, last_movement_id: led.ledger_id }, userId);
  return { ledger_id: led.ledger_id, grn_id: grn.grn_id, on_hand_qty: newQty, moving_avg_cost: newAvg, stock_value: newVal };
}

// Issue stock at MWAC; optionally straight onto a job card (unifies stores/oil with workshop).
async function postIssue(c, { itemId, locationId, qty, jobcardId = null, assetId = null, date, siteId, userId }) {
  if (!(qty > 0)) throw new Error('qty must be > 0');
  const bal = await balanceOf(c, itemId, locationId);
  if (bal._new || Number(bal.on_hand_qty) < qty)
    throw new Error(`insufficient stock: on hand ${Number(bal.on_hand_qty) || 0}, requested ${qty}`);
  const avg = Number(bal.moving_avg_cost);
  const lineAmt = money(qty * avg);
  const newQty = qty4(Number(bal.on_hand_qty) - qty);
  const newVal = money(newQty * avg);
  const item = (await c.query('SELECT base_uom_id FROM md_item WHERE item_id=$1', [itemId])).rows[0];
  const scode = await siteCodeOf(c, siteId);

  const iss = (await c.query(
    `INSERT INTO tx_issue(issue_no, issue_date, location_id, issue_type, asset_id, jobcard_id, total_amt, doc_status, site_id, created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,'POSTED',$8,$9) RETURNING issue_id`,
    [await nextNo('ISS', scode, date, c), date, locationId, jobcardId ? 'JOB' : 'STORE', assetId, jobcardId, lineAmt, siteId, userId])).rows[0];
  const led = (await c.query(
    `INSERT INTO mv_stock_ledger(movement_no, movement_date, item_id, location_id, mv_direction, qty, unit_cost, value_amt,
         running_balance_qty, running_balance_value, running_avg_cost, source_doc_type, source_doc_id, posted_by, posted_at, site_id, created_by)
     VALUES($1,$2,$3,$4,'OUT',$5,$6,$7,$8,$9,$10,'ISSUE',$11,$12,now(),$13,$12) RETURNING ledger_id`,
    [await nextNo('MOV', scode, date, c), date, itemId, locationId, qty, avg, lineAmt, newQty, newVal, avg, iss.issue_id, userId, siteId])).rows[0];
  const issLine = (await c.query(
    `INSERT INTO txl_issue(issue_id, line_no, item_id, uom_id, issued_qty, unit_cost, line_amt, ledger_id, created_by)
     VALUES($1,1,$2,$3,$4,$5,$6,$7,$8) RETURNING issue_line_id`,
    [iss.issue_id, itemId, item.base_uom_id, qty, avg, lineAmt, led.ledger_id, userId])).rows[0];
  await upsertBalance(c, itemId, locationId, { on_hand_qty: newQty, moving_avg_cost: avg, stock_value: newVal, last_movement_id: led.ledger_id }, userId);

  let job_part_id = null;
  if (jobcardId) {
    job_part_id = (await c.query(
      `INSERT INTO tx_job_parts(jobcard_id, item_id, uom_id, qty, unit_cost, part_cost, source_type, issue_line_id, ledger_id, site_id, created_by)
       VALUES($1,$2,$3,$4,$5,$6,'ISSUE',$7,$8,$9,$10) RETURNING job_part_id`,
      [jobcardId, itemId, item.base_uom_id, qty, avg, lineAmt, issLine.issue_line_id, led.ledger_id, siteId, userId])).rows[0].job_part_id;
  }
  return { issue_id: iss.issue_id, issue_line_id: issLine.issue_line_id, unit_cost: avg, line_amt: lineAmt, on_hand_qty: newQty, job_part_id };
}

// Physical count -> variance -> optional ADJ movement to reconcile book to counted.
async function postCount(c, { itemId, locationId, countedQty, date, siteId, userId, reason = 'COUNT' }) {
  const bal = await balanceOf(c, itemId, locationId);
  const book = Number(bal.on_hand_qty) || 0;
  const avg = Number(bal.moving_avg_cost) || 0;
  const variance = qty4(countedQty - book);
  if (variance === 0) return { book_qty: book, counted_qty: qty4(countedQty), variance: 0, adjusted: false };
  const dir = variance > 0 ? 'ADJ_IN' : 'ADJ_OUT';
  const absQ = Math.abs(variance);
  const newVal = money(countedQty * avg);
  const scode = await siteCodeOf(c, siteId);

  const adj = (await c.query(
    `INSERT INTO tx_adjustment(adjustment_no, adjustment_date, location_id, adjustment_type, reason_code, total_amt, doc_status, site_id, created_by)
     VALUES($1,$2,$3,'COUNT',$4,$5,'POSTED',$6,$7) RETURNING adjustment_id`,
    [await nextNo('ADJ', scode, date, c), date, locationId, reason, money(absQ * avg), siteId, userId])).rows[0];
  const led = (await c.query(
    `INSERT INTO mv_stock_ledger(movement_no, movement_date, item_id, location_id, mv_direction, qty, unit_cost, value_amt,
         running_balance_qty, running_balance_value, running_avg_cost, source_doc_type, source_doc_id, posted_by, posted_at, site_id, created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'ADJUST',$12,$13,now(),$14,$13) RETURNING ledger_id`,
    [await nextNo('MOV', scode, date, c), date, itemId, locationId, dir, absQ, avg, money(absQ * avg),
     qty4(countedQty), newVal, avg, adj.adjustment_id, userId, siteId])).rows[0];
  await c.query(
    `INSERT INTO txl_adjustment(adjustment_id, line_no, item_id, uom_id, system_qty, counted_qty, adjust_qty, mv_direction, unit_cost, line_amt, ledger_id, created_by)
     SELECT $1,1,$2,base_uom_id,$3,$4,$5,$6,$7,$8,$9,$10 FROM md_item WHERE item_id=$2`,
    [adj.adjustment_id, itemId, book, qty4(countedQty), variance, dir, avg, money(absQ * avg), led.ledger_id, userId]);
  await upsertBalance(c, itemId, locationId, { on_hand_qty: qty4(countedQty), moving_avg_cost: avg, stock_value: newVal, last_movement_id: led.ledger_id }, userId);
  return { book_qty: book, counted_qty: qty4(countedQty), variance, adjusted: true, direction: dir, value_impact: money(absQ * avg) };
}

module.exports = { postReceive, postIssue, postCount, balanceOf, siteCodeOf, money, qty4 };
