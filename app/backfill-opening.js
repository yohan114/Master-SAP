// Backfill opening stock balances into the unified ledger from the legacy books.
// Computes current on-hand (received − issued) and a weighted-average cost per item,
// maps it to the migrated md_item catalog by name, and posts it as one OPENING
// adjustment (a GAIN doc) with an ADJ_IN movement + balance per item. Idempotent:
// re-running skips items that already have a balance. Run AFTER migrate-legacy.js.
//
//   STORES_DB=/path/inventory.db OIL_DB=/path/oilbook.db node backfill-opening.js
const { DatabaseSync } = require('node:sqlite');
const { q, one, tx } = require('./db');
const { nextNo, ensureCounterTable } = require('./lib/numbering');

const STORES_DB = process.env.STORES_DB;
const OIL_DB = process.env.OIL_DB;
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const qty4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;

(async () => {
  await ensureCounterTable();            // numbering table (normally created at server boot)
  const admin = await one("SELECT user_id FROM sec_user WHERE username='admin'");
  if (!admin) throw new Error('run seed.js + migrate-legacy.js first');
  const CB = admin.user_id;
  const site = await one("SELECT location_id FROM md_location WHERE location_code='HQ'");
  const siteId = site.location_id;

  // unified catalog: normalized name -> {item_id, uom}
  const nameMap = new Map();
  for (const r of await q('SELECT item_id, item_name, base_uom_id FROM md_item')) {
    const k = norm(r.item_name); if (!nameMap.has(k)) nameMap.set(k, r);
  }
  // items that already have a balance (idempotency)
  const have = new Set((await q('SELECT item_id FROM inv_stock_balance')).map((r) => String(r.item_id)));

  // ---- gather opening qty + cost per unified item_id ----
  const open = new Map(); // item_id -> {qty, cost}
  const add = (itemName, qty, cost) => {
    const it = nameMap.get(norm(itemName)); if (!it || !(qty > 0)) return;
    if (have.has(String(it.item_id))) return;
    open.set(String(it.item_id), { item_id: it.item_id, uom: it.base_uom_id, qty: qty4(qty), cost: money(cost) });
  };

  if (STORES_DB) {
    const inv = new DatabaseSync(STORES_DB, { readOnly: true });
    // on-hand = received − issued per item name; avg cost from priced receipts
    const rows = inv.prepare(`
      WITH recv AS (SELECT LOWER(TRIM(i.itemName)) nm, SUM(r.qty) qty,
                      SUM(CASE WHEN r.unitPrice>0 THEN r.qty*r.unitPrice ELSE 0 END) val,
                      SUM(CASE WHEN r.unitPrice>0 THEN r.qty ELSE 0 END) pqty
                    FROM items i JOIN receipts r ON r.itemId=i.id WHERE r.qty>0 GROUP BY LOWER(TRIM(i.itemName))),
           iss AS (SELECT LOWER(TRIM(itemName)) nm, SUM(qty) qty FROM issues WHERE qty>0 GROUP BY LOWER(TRIM(itemName)))
      SELECT recv.nm nm, recv.qty rq, COALESCE(iss.qty,0) iq,
             CASE WHEN recv.pqty>0 THEN recv.val/recv.pqty ELSE 0 END avgcost
      FROM recv LEFT JOIN iss ON iss.nm=recv.nm`).all();
    for (const r of rows) add(r.nm, Number(r.rq) - Number(r.iq), r.avgcost);

    // general items: last running balance
    for (const r of inv.prepare(`SELECT gi.itemName nm,
        (SELECT balance FROM general_item_transactions t WHERE t.itemId=gi.id ORDER BY t.txDateISO DESC, t.id DESC LIMIT 1) bal
        FROM general_items gi`).all()) add(r.nm, Number(r.bal), 0);
    inv.close();
  }
  if (OIL_DB) {
    const oil = new DatabaseSync(OIL_DB, { readOnly: true });
    for (const r of oil.prepare(`SELECT p.name nm, p.unit_price up,
        (SELECT balance_after FROM transactions t WHERE t.product_id=p.id ORDER BY t.txn_date DESC, t.id DESC LIMIT 1) bal
        FROM products p`).all()) add(r.nm, Number(r.bal), Number(r.up) || 0);
    oil.close();
  }

  const list = [...open.values()].filter((x) => x.qty > 0);
  if (!list.length) { console.log('Nothing to backfill (already done, or no positive balances).'); process.exit(0); }

  let posted = 0, value = 0;
  await tx(async (c) => {
    const adj = (await c.query(
      `INSERT INTO tx_adjustment(adjustment_no, adjustment_date, location_id, adjustment_type, reason_code, total_amt, doc_status, site_id, created_by)
       VALUES($1, CURRENT_DATE, $2, 'GAIN', 'OPENING', 0, 'POSTED', $2, $3) RETURNING adjustment_id`,
      [await nextNo('ADJ', 'HQ', new Date().toISOString(), c), siteId, CB])).rows[0];
    let line = 0, total = 0;
    for (const x of list) {
      const val = money(x.qty * x.cost);
      const mno = await nextNo('MOV', 'HQ', new Date().toISOString(), c);
      const led = (await c.query(
        `INSERT INTO mv_stock_ledger(movement_no, movement_date, item_id, location_id, mv_direction, qty, unit_cost, value_amt,
             running_balance_qty, running_balance_value, running_avg_cost, source_doc_type, source_doc_id, posted_by, posted_at, site_id, created_by)
         VALUES($1, CURRENT_DATE, $2, $3, 'ADJ_IN', $4, $5, $6, $4, $6, $5, 'ADJUST', $7, $8, now(), $3, $8) RETURNING ledger_id`,
        [mno, x.item_id, siteId, x.qty, x.cost, val, adj.adjustment_id, CB])).rows[0];
      await c.query(
        `INSERT INTO txl_adjustment(adjustment_id, line_no, item_id, uom_id, system_qty, counted_qty, adjust_qty, mv_direction, unit_cost, line_amt, ledger_id, created_by)
         VALUES($1,$2,$3,$4,0,$5,$5,'ADJ_IN',$6,$7,$8,$9)`,
        [adj.adjustment_id, ++line, x.item_id, x.uom, x.qty, x.cost, val, led.ledger_id, CB]);
      await c.query(
        `INSERT INTO inv_stock_balance(item_id, location_id, on_hand_qty, moving_avg_cost, stock_value, last_movement_id, last_movement_at, last_receipt_date, created_by)
         VALUES($1,$2,$3,$4,$5,$6,now(),CURRENT_DATE,$7)
         ON CONFLICT (item_id, location_id) DO NOTHING`,
        [x.item_id, siteId, x.qty, x.cost, val, led.ledger_id, CB]);
      posted++; total += val;
    }
    await c.query('UPDATE tx_adjustment SET total_amt=$1 WHERE adjustment_id=$2', [money(total), adj.adjustment_id]);
    value = total;
  });

  const tot = await one("SELECT COUNT(*) lines, COALESCE(SUM(stock_value),0) val FROM inv_stock_balance");
  console.log(`Backfilled ${posted} opening balances (LKR ${money(value)}).`);
  console.log(`Now in stock: ${tot.lines} item-locations, total value LKR ${money(tot.val)}.`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
