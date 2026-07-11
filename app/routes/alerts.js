// Alerts & reorder engine — the exception board for the dashboard. One endpoint computes every
// watch condition and returns grouped, drill-in rows (with columns, so the UI renders them like a
// report): low stock (reorder / below-minimum), lubricant days-left forecast, battery warranty
// due/expired, overdue job cards, and pending pricing. Reorder/min live on md_item; consumption
// comes from the ledger; warranty from md_battery; overdue from the job's promised_date.
const express = require('express');
const { q } = require('../db');
const { scopeSql } = require('../auth/mw');

const router = express.Router();
const iso = (d) => d.toISOString().slice(0, 10);
const num = (x) => Number(x) || 0;
const round1 = (n) => Math.round(n * 10) / 10;

const REORDER_DAYS = 14;   // lubricant "days of cover" threshold
const WARRANTY_SOON_DAYS = 30;

router.get('/', async (req, res) => {
  try {
    const today = new Date();
    const todayStr = iso(today);
    const in30 = iso(new Date(today.getTime() + WARRANTY_SOON_DAYS * 86400000));
    const ago30 = iso(new Date(today.getTime() - 30 * 86400000));
    const groups = [];

    // --- low stock: reorder + below-minimum (aggregated across locations) ---
    const low = await q(
      `SELECT i.item_no, i.item_name, i.reorder_level, i.reorder_qty, i.min_qty,
              COALESCE((SELECT SUM(b.available_qty) FROM inv_stock_balance b WHERE b.item_id=i.item_id),0) AS available
       FROM md_item i WHERE i.is_active AND i.is_stockable AND i.reorder_level > 0`);
    const belowMin = [], reorder = [];
    for (const r of low) {
      const avail = num(r.available);
      if (avail > num(r.reorder_level)) continue;                 // healthy
      (num(r.min_qty) > 0 && avail <= num(r.min_qty) ? belowMin : reorder).push({
        item_no: r.item_no, item_name: r.item_name, available: avail,
        reorder_level: num(r.reorder_level), min_qty: num(r.min_qty), suggest_order: num(r.reorder_qty),
      });
    }
    const stockCols = [{ k: 'item_no', h: 'Item No' }, { k: 'item_name', h: 'Item' }, { k: 'available', h: 'Available', n: true },
      { k: 'reorder_level', h: 'Reorder', n: true }, { k: 'min_qty', h: 'Min', n: true }, { k: 'suggest_order', h: 'Suggest', n: true }];
    groups.push({ key: 'below-minimum', title: 'Below minimum stock', severity: 'high', columns: stockCols, count: belowMin.length, rows: belowMin });
    groups.push({ key: 'reorder', title: 'At / below reorder level', severity: 'warn', columns: stockCols, count: reorder.length, rows: reorder });

    // --- lubricant days-of-cover forecast ---
    const lubes = await q(
      `SELECT i.item_no, i.item_name,
              COALESCE((SELECT SUM(b.available_qty) FROM inv_stock_balance b WHERE b.item_id=i.item_id),0) AS on_hand,
              COALESCE((SELECT SUM(g.qty) FROM mv_stock_ledger g WHERE g.item_id=i.item_id AND g.mv_direction='OUT' AND g.movement_date >= $1),0) AS used
       FROM md_item i WHERE i.is_active AND i.item_type='LUBRICANT'`, [ago30]);
    const lubLow = [];
    for (const r of lubes) {
      const avgDaily = num(r.used) / 30;
      if (!(avgDaily > 0)) continue;
      const daysLeft = round1(num(r.on_hand) / avgDaily);
      if (daysLeft < REORDER_DAYS) lubLow.push({ item_no: r.item_no, item_name: r.item_name, on_hand: round1(num(r.on_hand)), avg_daily: round1(avgDaily), days_left: daysLeft });
    }
    groups.push({
      key: 'lubricant', title: 'Lubricant running low (days of cover)', severity: 'warn',
      columns: [{ k: 'item_no', h: 'Code' }, { k: 'item_name', h: 'Product' }, { k: 'on_hand', h: 'On hand', n: true }, { k: 'avg_daily', h: 'Avg/day', n: true }, { k: 'days_left', h: 'Days left', n: true }],
      count: lubLow.length, rows: lubLow,
    });

    // --- battery warranty due / expired ---
    const bsc = scopeSql(req, 'bt', 2);
    const bats = await q(
      `SELECT bt.battery_serial_no, i.item_name AS model, bt.warranty_end_date, bt.battery_status
       FROM md_battery bt JOIN md_item i ON i.item_id=bt.item_id
       WHERE bt.is_active AND bt.warranty_end_date IS NOT NULL AND bt.warranty_end_date <= $1
         AND bt.battery_status NOT IN ('SCRAPPED','REPLACED','LOST')${bsc.sql}
       ORDER BY bt.warranty_end_date`, [in30, ...bsc.params]);
    const dstr = (x) => (typeof x === 'string' ? x.slice(0, 10) : iso(new Date(x)));
    const warr = bats.map((r) => { const end = dstr(r.warranty_end_date); return { battery_serial_no: r.battery_serial_no, model: r.model, warranty_end_date: end, state: end < todayStr ? 'EXPIRED' : 'DUE SOON' }; });
    groups.push({
      key: 'battery-warranty', title: 'Battery warranty due / expired', severity: warr.some((w) => w.state === 'EXPIRED') ? 'high' : 'warn',
      columns: [{ k: 'battery_serial_no', h: 'Serial' }, { k: 'model', h: 'Model' }, { k: 'warranty_end_date', h: 'Warranty end' }, { k: 'state', h: 'State' }],
      count: warr.length, rows: warr,
    });

    // --- overdue job cards (past promised date, not closed) ---
    const jsc = scopeSql(req, 'jc', 2);
    const overdue = await q(
      `SELECT jc.jobcard_no, a.asset_no, jc.jobcard_status, jc.promised_date
       FROM tx_jobcard jc JOIN md_asset a ON a.asset_id=jc.asset_id
       WHERE jc.is_active AND jc.promised_date IS NOT NULL AND jc.promised_date < $1
         AND jc.jobcard_status NOT IN ('CLOSED','CANCELLED','REJECTED')${jsc.sql}
       ORDER BY jc.promised_date`, [todayStr, ...jsc.params]);
    groups.push({
      key: 'overdue-jobs', title: 'Overdue job cards', severity: 'high',
      columns: [{ k: 'jobcard_no', h: 'Job No' }, { k: 'asset_no', h: 'Asset' }, { k: 'jobcard_status', h: 'Status' }, { k: 'promised_date', h: 'Promised' }],
      count: overdue.length, rows: overdue,
    });

    // --- pending pricing (received, not yet confirmed) ---
    const psc = scopeSql(req, 'p', 1);
    const pend = await q(
      `SELECT g.grn_no, i.item_no, i.item_name, p.received_qty, p.provisional_unit_cost
       FROM inv_pending_price p JOIN md_item i ON i.item_id=p.item_id JOIN tx_grn g ON g.grn_id=p.grn_id
       WHERE p.is_active AND p.price_status<>'CONFIRMED'${psc.sql} ORDER BY p.pending_id DESC`, psc.params);
    groups.push({
      key: 'pending-pricing', title: 'Pending pricing', severity: 'info',
      columns: [{ k: 'grn_no', h: 'GRN' }, { k: 'item_no', h: 'Item No' }, { k: 'item_name', h: 'Item' }, { k: 'received_qty', h: 'Qty', n: true }, { k: 'provisional_unit_cost', h: 'Provisional', n: true }],
      count: pend.length, rows: pend,
    });

    res.json({ today: todayStr, total: groups.reduce((s, g) => s + g.count, 0), groups });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
