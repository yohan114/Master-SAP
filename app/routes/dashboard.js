// Consolidated dashboard KPIs + a 7-day stock-movement series, in one call. Site-scoped where the
// table carries site_id (jobs, MRNs, batteries, pending-price, ledger); stock-balance/item-master
// metrics are global (inv_stock_balance has no site_id). Field NAMES match the requested contract;
// the SQL is mapped to this app's real schema — see the notes on each metric.
const express = require('express');
const { q, one } = require('../db');
const { scopeSql } = require('../auth/mw');

const router = express.Router();
const iso = (d) => d.toISOString().slice(0, 10);
const n = (x) => Number(x) || 0;

router.get('/kpis', async (req, res) => {
  try {
    const today = new Date();
    const in30 = iso(new Date(today.getTime() + 30 * 86400000));
    const ago30 = iso(new Date(today.getTime() - 30 * 86400000));
    const ago7 = iso(new Date(today.getTime() - 6 * 86400000));   // 7 days incl. today

    // stockValue — SUM(on_hand_qty × moving_avg_cost), kept live in stock_value. Global (no site_id).
    const sv = await one('SELECT COALESCE(SUM(stock_value),0) AS v FROM inv_stock_balance');

    // openJobCards — this app's terminal states are CLOSED/CANCELLED/REJECTED (not just CLOSED).
    const jsc = scopeSql(req, 'j', 1);
    const oj = await one(`SELECT COUNT(*) AS c FROM tx_jobcard j
      WHERE j.is_active AND j.jobcard_status NOT IN ('CLOSED','CANCELLED','REJECTED')${jsc.sql}`, jsc.params);

    // pendingMRNs — no literal 'PENDING' status exists; "pending" = not yet closed/cancelled.
    const msc = scopeSql(req, 'm', 1);
    const pm = await one(`SELECT COUNT(*) AS c FROM tx_mrn m
      WHERE m.is_active AND m.doc_status NOT IN ('CLOSED','CANCELLED')${msc.sql}`, msc.params);

    // reorderAlerts — available (on_hand − reserved, aggregated across locations) ≤ reorder_level.
    const ra = await one(`SELECT COUNT(*) AS c FROM (
        SELECT i.item_id, i.reorder_level,
               COALESCE((SELECT SUM(b.available_qty) FROM inv_stock_balance b WHERE b.item_id=i.item_id),0) AS avail
        FROM md_item i WHERE i.is_active AND i.is_stockable AND i.reorder_level > 0) t
      WHERE t.avail <= t.reorder_level`);

    // batteriesWarrantyDue — warranty_end_date within 30 days (or already past), non-scrapped.
    const bsc = scopeSql(req, 'bt', 2);
    const bw = await one(`SELECT COUNT(*) AS c FROM md_battery bt
      WHERE bt.is_active AND bt.warranty_end_date IS NOT NULL AND bt.warranty_end_date <= $1
        AND bt.battery_status NOT IN ('SCRAPPED','REPLACED','LOST')${bsc.sql}`, [in30, ...bsc.params]);

    // lubricantDaysCover — min(on_hand ÷ avg daily consumption) across lubricants with consumption.
    const lubes = await q(`SELECT i.item_id,
        COALESCE((SELECT SUM(b.available_qty) FROM inv_stock_balance b WHERE b.item_id=i.item_id),0) AS on_hand,
        COALESCE((SELECT SUM(g.qty) FROM mv_stock_ledger g WHERE g.item_id=i.item_id AND g.mv_direction='OUT' AND g.movement_date >= $1),0) AS used
      FROM md_item i WHERE i.is_active AND i.item_type='LUBRICANT'`, [ago30]);
    let minDays = null;
    for (const r of lubes) { const avg = n(r.used) / 30; if (avg > 0) { const d = Math.round((n(r.on_hand) / avg) * 10) / 10; if (minDays === null || d < minDays) minDays = d; } }

    // pendingPricing — GRNs with received stock still awaiting a confirmed price.
    const psc = scopeSql(req, 'p', 1);
    const pp = await one(`SELECT COUNT(DISTINCT p.grn_id) AS c FROM inv_pending_price p
      WHERE p.is_active AND p.price_status<>'CONFIRMED'${psc.sql}`, psc.params);

    // 7-day stock movement (net qty per day) for the sparkline.
    const gsc = scopeSql(req, 'g', 2);
    const trend = await q(`SELECT g.movement_date AS d,
        SUM(CASE WHEN g.mv_direction IN ('IN','XFER_IN','ADJ_IN','RET_IN') THEN g.qty
                 WHEN g.mv_direction IN ('OUT','XFER_OUT','ADJ_OUT','RET_OUT') THEN -g.qty ELSE 0 END) AS net
      FROM mv_stock_ledger g WHERE g.movement_date >= $1${gsc.sql}
      GROUP BY g.movement_date ORDER BY g.movement_date`, [ago7, ...gsc.params]);
    const byDay = new Map(trend.map((r) => [String(r.d).slice(0, 10), n(r.net)]));
    const stockTrend = [];
    for (let i = 6; i >= 0; i--) { const day = iso(new Date(today.getTime() - i * 86400000)); stockTrend.push({ date: day, net: byDay.get(day) || 0 }); }

    res.json({
      stockValue: n(sv.v),
      openJobCards: n(oj.c),
      pendingMRNs: n(pm.c),
      reorderAlerts: n(ra.c),
      batteriesWarrantyDue: n(bw.c),
      lubricantDaysCover: minDays,        // null when no lubricant has recorded consumption
      pendingPricing: n(pp.c),
      stockTrend,                         // [{date, net}] × 7 for the movement sparkline
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
