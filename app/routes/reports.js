// Reports — read-only, exportable views over the data the modules capture. A small registry maps a
// report key to its columns + a SQL builder; one generic runner applies the date range and the
// caller's site scope, so every report is site-safe and CSV-exportable (the UI serialises rows).
const express = require('express');
const { q } = require('../db');
const { scopeSql } = require('../auth/mw');

const router = express.Router();

// col: { k: field, h: header, n: numeric (right-align / money) }
const REPORTS = {
  'stock-ledger': {
    title: 'Stock ledger (movement history)', desc: 'Every stock movement — receipts, issues, transfers, adjustments.', dated: true, scope: 'g', chart: true,
    columns: [{ k: 'movement_no', h: 'Movement' }, { k: 'movement_date', h: 'Date' }, { k: 'item_no', h: 'Item No' }, { k: 'item_name', h: 'Item' },
      { k: 'location_code', h: 'Loc' }, { k: 'mv_direction', h: 'Dir' }, { k: 'qty', h: 'Qty', n: true }, { k: 'unit_cost', h: 'Unit', n: true },
      { k: 'value_amt', h: 'Value', n: true }, { k: 'running_balance_qty', h: 'Balance', n: true }, { k: 'source_doc_type', h: 'Doc' }],
    sql: (sc) => `SELECT g.movement_no, g.movement_date, i.item_no, i.item_name, l.location_code, g.mv_direction,
        g.qty, g.unit_cost, g.value_amt, g.running_balance_qty, g.source_doc_type
      FROM mv_stock_ledger g JOIN md_item i ON i.item_id=g.item_id JOIN md_location l ON l.location_id=g.location_id
      WHERE g.movement_date BETWEEN $1 AND $2${sc} ORDER BY g.ledger_id DESC LIMIT 2000`,
  },
  'stock-balance': {
    title: 'Stock balance & valuation', desc: 'Current on-hand quantity, moving-average cost and value per item-location.', dated: false, scope: null,
    columns: [{ k: 'item_no', h: 'Item No' }, { k: 'item_name', h: 'Item' }, { k: 'item_type', h: 'Type' }, { k: 'location_code', h: 'Loc' },
      { k: 'on_hand_qty', h: 'On hand', n: true }, { k: 'moving_avg_cost', h: 'Avg cost', n: true }, { k: 'stock_value', h: 'Value', n: true }],
    sql: () => `SELECT i.item_no, i.item_name, i.item_type, l.location_code, b.on_hand_qty, b.moving_avg_cost, b.stock_value
      FROM inv_stock_balance b JOIN md_item i ON i.item_id=b.item_id JOIN md_location l ON l.location_id=b.location_id
      WHERE b.on_hand_qty <> 0 ORDER BY i.item_no, l.location_code`,
  },
  'item-movement': {
    title: 'Item movement summary', desc: 'Total in / out and movement count per item over the period.', dated: true, scope: 'g',
    columns: [{ k: 'item_no', h: 'Item No' }, { k: 'item_name', h: 'Item' }, { k: 'qty_in', h: 'In', n: true }, { k: 'qty_out', h: 'Out', n: true }, { k: 'movements', h: 'Moves', n: true }],
    sql: (sc) => `SELECT i.item_no, i.item_name,
        SUM(CASE WHEN g.mv_direction IN ('IN','XFER_IN','ADJ_IN','RET_IN') THEN g.qty ELSE 0 END) AS qty_in,
        SUM(CASE WHEN g.mv_direction IN ('OUT','XFER_OUT','ADJ_OUT','RET_OUT') THEN g.qty ELSE 0 END) AS qty_out,
        COUNT(*) AS movements
      FROM mv_stock_ledger g JOIN md_item i ON i.item_id=g.item_id
      WHERE g.movement_date BETWEEN $1 AND $2${sc} GROUP BY i.item_no, i.item_name ORDER BY movements DESC LIMIT 500`,
  },
  'lubricant-issue': {
    title: 'Lubricant issue by vehicle', desc: 'Every lubricant issue with the vehicle/machine it went to.', dated: true, scope: 'g',
    columns: [{ k: 'movement_date', h: 'Date' }, { k: 'asset_no', h: 'Vehicle' }, { k: 'item_no', h: 'Code' }, { k: 'item_name', h: 'Product' },
      { k: 'qty', h: 'Litres', n: true }, { k: 'value_amt', h: 'Value', n: true }],
    sql: (sc) => `SELECT g.movement_date, a.asset_no, i.item_no, i.item_name, g.qty, g.value_amt
      FROM mv_stock_ledger g JOIN md_item i ON i.item_id=g.item_id AND i.item_type='LUBRICANT'
      JOIN tx_issue t ON t.issue_id=g.source_doc_id AND g.source_doc_type='ISSUE'
      JOIN md_asset a ON a.asset_id=t.asset_id
      WHERE g.mv_direction='OUT' AND g.movement_date BETWEEN $1 AND $2${sc} ORDER BY g.ledger_id DESC LIMIT 1000`,
  },
  'supplier-spend': {
    title: 'Supplier spend (GRN)', desc: 'Value received per supplier over the period.', dated: true, scope: 'g',
    columns: [{ k: 'supplier_no', h: 'Supplier No' }, { k: 'supplier_name', h: 'Supplier' }, { k: 'grns', h: 'GRNs', n: true }, { k: 'total_received', h: 'Total received', n: true }],
    sql: (sc) => `SELECT s.supplier_no, s.supplier_name, COUNT(DISTINCT g.grn_id) AS grns, COALESCE(SUM(g.total_amt),0) AS total_received
      FROM tx_grn g JOIN md_supplier s ON s.supplier_id=g.supplier_id
      WHERE g.grn_date BETWEEN $1 AND $2${sc} GROUP BY s.supplier_no, s.supplier_name ORDER BY total_received DESC`,
  },
  'job-costing': {
    title: 'Job costing sheet', desc: 'Cost breakdown per job — material, labour, general, outside, total and variance.', dated: true, scope: 'cs', chart: true,
    columns: [{ k: 'jobcard_no', h: 'Job No' }, { k: 'asset_no', h: 'Asset' }, { k: 'jobcard_status', h: 'Status' },
      { k: 'material_cost', h: 'Material', n: true }, { k: 'labour_cost', h: 'Labour', n: true }, { k: 'general_cost', h: 'General', n: true },
      { k: 'outside_repair_cost', h: 'Outside', n: true }, { k: 'total_job_cost', h: 'Total', n: true }, { k: 'estimated_cost', h: 'Est.', n: true }, { k: 'variance_amt', h: 'Variance', n: true }],
    sql: (sc) => `SELECT jc.jobcard_no, a.asset_no, jc.jobcard_status, cs.material_cost, cs.labour_cost, cs.general_cost,
        cs.outside_repair_cost, cs.total_job_cost, cs.estimated_cost, cs.variance_amt
      FROM cost_job_summary cs JOIN tx_jobcard jc ON jc.jobcard_id=cs.jobcard_id JOIN md_asset a ON a.asset_id=jc.asset_id
      WHERE jc.jobcard_date BETWEEN $1 AND $2${sc} ORDER BY cs.summary_id DESC LIMIT 500`,
  },
  'labour-summary': {
    title: 'Labour summary by technician', desc: 'Hours and cost per technician over the period.', dated: true, scope: 'jl',
    columns: [{ k: 'employee_no', h: 'Emp No' }, { k: 'employee_name', h: 'Technician' }, { k: 'entries', h: 'Entries', n: true },
      { k: 'hours', h: 'Hrs', n: true }, { k: 'ot_hours', h: 'OT', n: true }, { k: 'labour_cost', h: 'Cost', n: true }],
    sql: (sc) => `SELECT e.employee_no, e.employee_name, COUNT(*) AS entries, SUM(jl.hours) AS hours, SUM(jl.ot_hours) AS ot_hours, SUM(jl.labour_cost) AS labour_cost
      FROM tx_job_labour jl JOIN md_employee e ON e.employee_id=jl.employee_id
      WHERE jl.is_active AND jl.labour_date BETWEEN $1 AND $2${sc} GROUP BY e.employee_no, e.employee_name ORDER BY labour_cost DESC`,
  },
  'open-jobs': {
    title: 'Open job cards', desc: 'Job cards not yet closed, with status.', dated: false, scope: 'jc',
    columns: [{ k: 'jobcard_no', h: 'Job No' }, { k: 'jobcard_date', h: 'Date' }, { k: 'asset_no', h: 'Asset' }, { k: 'job_type', h: 'Type' },
      { k: 'jobcard_status', h: 'Status' }, { k: 'estimated_cost', h: 'Est.', n: true }, { k: 'total_job_cost', h: 'Actual', n: true }],
    sql: (sc) => `SELECT jc.jobcard_no, jc.jobcard_date, a.asset_no, jc.job_type, jc.jobcard_status, jc.estimated_cost, jc.total_job_cost
      FROM tx_jobcard jc JOIN md_asset a ON a.asset_id=jc.asset_id
      WHERE jc.is_active AND jc.jobcard_status NOT IN ('CLOSED','CANCELLED','REJECTED')${sc} ORDER BY jc.jobcard_date LIMIT 500`,
  },
  'variance': {
    title: 'Job cost variance', desc: 'Estimated vs actual cost and variance per costed job.', dated: false, scope: 'cs',
    columns: [{ k: 'jobcard_no', h: 'Job No' }, { k: 'asset_no', h: 'Asset' }, { k: 'estimated_cost', h: 'Estimated', n: true },
      { k: 'total_job_cost', h: 'Actual', n: true }, { k: 'variance_amt', h: 'Variance', n: true }, { k: 'variance_pct', h: 'Var %', n: true }],
    sql: (sc) => `SELECT jc.jobcard_no, a.asset_no, cs.estimated_cost, cs.total_job_cost, cs.variance_amt, cs.variance_pct
      FROM cost_job_summary cs JOIN tx_jobcard jc ON jc.jobcard_id=cs.jobcard_id JOIN md_asset a ON a.asset_id=jc.asset_id
      WHERE 1=1${sc} ORDER BY cs.variance_amt DESC LIMIT 500`,
  },
  'battery-lifecycle': {
    title: 'Battery lifecycle', desc: 'Full event history per battery (register → install → transfer → return → scrap).', dated: false, scope: 'ev',
    columns: [{ k: 'battery_serial_no', h: 'Serial' }, { k: 'model', h: 'Model' }, { k: 'event_seq', h: '#', n: true }, { k: 'event_type', h: 'Event' },
      { k: 'event_date', h: 'Date' }, { k: 'from_status', h: 'From' }, { k: 'to_status', h: 'To' }, { k: 'to_asset', h: 'Asset' }],
    sql: (sc) => `SELECT bt.battery_serial_no, i.item_name AS model, ev.event_seq, ev.event_type, ev.event_date, ev.from_status, ev.to_status, ta.asset_no AS to_asset
      FROM hist_battery_event ev JOIN md_battery bt ON bt.battery_id=ev.battery_id JOIN md_item i ON i.item_id=bt.item_id
      LEFT JOIN md_asset ta ON ta.asset_id=ev.to_asset_id
      WHERE 1=1${sc} ORDER BY ev.event_id DESC LIMIT 1000`,
  },
  'battery-by-vehicle': {
    title: 'Battery by vehicle', desc: 'Batteries currently fitted, by vehicle.', dated: false, scope: 'bt',
    columns: [{ k: 'asset_no', h: 'Vehicle' }, { k: 'asset_name', h: 'Name' }, { k: 'battery_serial_no', h: 'Serial' }, { k: 'model', h: 'Model' }, { k: 'battery_status', h: 'Status' }],
    sql: (sc) => `SELECT a.asset_no, a.asset_name, bt.battery_serial_no, i.item_name AS model, bt.battery_status
      FROM md_battery bt JOIN md_item i ON i.item_id=bt.item_id JOIN md_asset a ON a.asset_id=bt.current_asset_id
      WHERE bt.is_active AND bt.current_asset_id IS NOT NULL${sc} ORDER BY a.asset_no`,
  },
  'pending-pricing': {
    title: 'Pending pricing', desc: 'Received stock still awaiting a confirmed purchase price.', dated: false, scope: 'p',
    columns: [{ k: 'grn_no', h: 'GRN' }, { k: 'item_no', h: 'Item No' }, { k: 'item_name', h: 'Item' }, { k: 'received_qty', h: 'Qty', n: true },
      { k: 'provisional_unit_cost', h: 'Provisional', n: true }, { k: 'price_status', h: 'Status' }],
    sql: (sc) => `SELECT g.grn_no, i.item_no, i.item_name, p.received_qty, p.provisional_unit_cost, p.price_status
      FROM inv_pending_price p JOIN md_item i ON i.item_id=p.item_id JOIN tx_grn g ON g.grn_id=p.grn_id
      WHERE p.is_active AND p.price_status<>'CONFIRMED'${sc} ORDER BY p.pending_id DESC LIMIT 500`,
  },
  'audit-trail': {
    title: 'Audit trail (stock postings)', desc: 'Who posted what and when — every ledger movement with its actor.', dated: true, scope: 'g',
    columns: [{ k: 'movement_no', h: 'Movement' }, { k: 'movement_date', h: 'Date' }, { k: 'source_doc_type', h: 'Doc' }, { k: 'item_no', h: 'Item No' },
      { k: 'mv_direction', h: 'Dir' }, { k: 'qty', h: 'Qty', n: true }, { k: 'value_amt', h: 'Value', n: true }, { k: 'posted_by', h: 'By' }, { k: 'posted_at', h: 'At' }],
    sql: (sc) => `SELECT g.movement_no, g.movement_date, g.source_doc_type, i.item_no, g.mv_direction, g.qty, g.value_amt, u.username AS posted_by, g.posted_at
      FROM mv_stock_ledger g JOIN md_item i ON i.item_id=g.item_id LEFT JOIN sec_user u ON u.user_id=g.posted_by
      WHERE g.movement_date BETWEEN $1 AND $2${sc} ORDER BY g.ledger_id DESC LIMIT 1000`,
  },
};

// ---- Chart views (?format=chart) ------------------------------------------
// Each builder returns a Chart.js config ({ type, data, options }) plus a `meta` block the web UI uses
// (available items, the reorder threshold, …). The JSON is a valid Chart.js config, so any Chart.js
// consumer — the web app, SAP, a BI tool — can render it directly.
const numv = (v) => Number(v) || 0;
const CHARTS = {
  // Line: on-hand (ledger running balance) over time for one item, with a reorder-level threshold line.
  'stock-ledger': async (req) => {
    const from = req.query.from || '1900-01-01', to = req.query.to || '2999-12-31';
    const s1 = scopeSql(req, 'g', 3);
    const items = await q(
      `SELECT DISTINCT i.item_no, i.item_name FROM mv_stock_ledger g JOIN md_item i ON i.item_id=g.item_id
       WHERE g.movement_date BETWEEN $1 AND $2${s1.sql} ORDER BY i.item_no`, [from, to, ...s1.params]);
    let itemNo = req.query.item;
    if (!itemNo || !items.some((x) => x.item_no === itemNo)) {   // default: the most-moved item in range
      const s0 = scopeSql(req, 'g', 3);
      const top = await q(`SELECT i.item_no FROM mv_stock_ledger g JOIN md_item i ON i.item_id=g.item_id
        WHERE g.movement_date BETWEEN $1 AND $2${s0.sql} GROUP BY i.item_no ORDER BY COUNT(*) DESC LIMIT 1`, [from, to, ...s0.params]);
      itemNo = (top[0] && top[0].item_no) || (items[0] && items[0].item_no) || null;
    }
    const meta = { report: 'stock-ledger', item_no: itemNo, items };
    if (!itemNo) return { type: 'line', data: { labels: [], datasets: [] }, options: {}, meta };
    const s2 = scopeSql(req, 'g', 4);
    const rows = await q(
      `SELECT g.movement_date, g.running_balance_qty FROM mv_stock_ledger g JOIN md_item i ON i.item_id=g.item_id
       WHERE i.item_no=$3 AND g.movement_date BETWEEN $1 AND $2${s2.sql} ORDER BY g.ledger_id`, [from, to, itemNo, ...s2.params]);
    const info = (await q('SELECT item_name, reorder_level FROM md_item WHERE item_no=$1', [itemNo]))[0] || {};
    const reorder = numv(info.reorder_level);
    const labels = rows.map((r) => String(r.movement_date));
    meta.item_name = info.item_name; meta.reorder_level = reorder;
    return {
      type: 'line',
      data: { labels, datasets: [
        { label: `On hand — ${itemNo}`, data: rows.map((r) => numv(r.running_balance_qty)), borderColor: '#d9820a', backgroundColor: 'rgba(217,130,10,0.12)', fill: true, tension: 0.2, pointRadius: 2, borderWidth: 2 },
        { label: `Reorder level (${reorder})`, data: labels.map(() => reorder), borderColor: '#c24a42', borderDash: [6, 4], pointRadius: 0, fill: false, borderWidth: 1.5 },
      ] },
      options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: true }, title: { display: true, text: `Stock on hand over time — ${itemNo}${info.item_name ? ' · ' + info.item_name : ''}` } },
        scales: { y: { beginAtZero: true, title: { display: true, text: 'Qty on hand' } }, x: { title: { display: true, text: 'Movement date' } } } },
      meta,
    };
  },
  // Grouped bar: labour vs parts vs outside-repair per closed job card.
  'job-costing': async (req) => {
    const from = req.query.from || '1900-01-01', to = req.query.to || '2999-12-31';
    const sc = scopeSql(req, 'cs', 3);
    const rows = await q(
      `SELECT jc.jobcard_no, cs.labour_cost, cs.material_cost, cs.general_cost, cs.outside_repair_cost
       FROM cost_job_summary cs JOIN tx_jobcard jc ON jc.jobcard_id=cs.jobcard_id
       WHERE jc.jobcard_status='CLOSED' AND jc.jobcard_date BETWEEN $1 AND $2${sc.sql}
       ORDER BY cs.summary_id DESC LIMIT 50`, [from, to, ...sc.params]);
    return {
      type: 'bar',
      data: { labels: rows.map((r) => r.jobcard_no), datasets: [
        { label: 'Labour', data: rows.map((r) => numv(r.labour_cost)), backgroundColor: '#2f74c0' },
        { label: 'Parts', data: rows.map((r) => numv(r.material_cost) + numv(r.general_cost)), backgroundColor: '#d9820a' },
        { label: 'Outside repair', data: rows.map((r) => numv(r.outside_repair_cost)), backgroundColor: '#1f9d63' },
      ] },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: true }, title: { display: true, text: 'Closed job costs — labour vs parts vs outside repair' } },
        scales: { y: { beginAtZero: true, title: { display: true, text: 'Cost (LKR)' } }, x: { title: { display: true, text: 'Job card' } } } },
      meta: { report: 'job-costing', count: rows.length },
    };
  },
};

// Catalogue.
router.get('/', (req, res) => {
  res.json({ reports: Object.entries(REPORTS).map(([key, d]) => ({ key, title: d.title, desc: d.desc, dated: !!d.dated, chart: !!d.chart })) });
});

// Run one report → { title, columns, rows }.
router.get('/:key', async (req, res) => {
  try {
    const def = REPORTS[req.params.key];
    if (!def) return res.status(404).json({ error: 'Unknown report' });
    if (req.query.format === 'chart') {
      const builder = CHARTS[req.params.key];
      if (!builder) return res.status(400).json({ error: 'This report has no chart view.' });
      return res.json(await builder(req));
    }
    const params = [];
    let startIdx = 1;
    if (def.dated) { params.push(req.query.from || '1900-01-01', req.query.to || '2999-12-31'); startIdx = 3; }
    const sc = def.scope ? scopeSql(req, def.scope, startIdx) : { sql: '', params: [] };
    const rows = await q(def.sql(sc.sql), [...params, ...sc.params]);
    res.json({ key: req.params.key, title: def.title, columns: def.columns, rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
