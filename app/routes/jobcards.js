// Workshop module — job cards, labour, parts, and the final cost roll-up.
// Every write is permission-gated + site-scoped + stamped with the actor.
const express = require('express');
const { q, one, tx } = require('../db');
const { requirePerm, scopeSql } = require('../auth/mw');
const { nextNo } = require('../lib/numbering');

const router = express.Router();
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

// site_code for numbering, from the job's site.
async function siteCodeOf(locationId) {
  const r = await one('SELECT site_code, location_code FROM md_location WHERE location_id=$1', [locationId]);
  return (r && (r.site_code || r.location_code || 'HQ')).trim().slice(0, 3).toUpperCase();
}

// ---- Job cards ------------------------------------------------------------

// List (site-scoped).
router.get('/', async (req, res) => {
  try {
    const sc = scopeSql(req, 'jc', 1);
    const rows = await q(
      `SELECT jc.jobcard_id, jc.jobcard_no, jc.jobcard_date, jc.job_type, jc.jobcard_status,
              jc.asset_id, a.asset_no, a.asset_name, jc.estimated_cost, jc.total_job_cost, jc.site_id
       FROM tx_jobcard jc JOIN md_asset a ON a.asset_id = jc.asset_id
       WHERE jc.is_active${sc.sql}
       ORDER BY jc.jobcard_id DESC LIMIT 200`, sc.params);
    res.json({ count: rows.length, rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create.
router.post('/', requirePerm('JOB.WRITE'), async (req, res) => {
  try {
    const b = req.body || {};
    const { asset_id, location_id, job_type = 'BREAKDOWN', reported_defect = null,
            estimated_cost = 0, jobcard_date = new Date().toISOString().slice(0, 10) } = b;
    if (!asset_id || !location_id) return res.status(400).json({ error: 'asset_id and location_id are required' });
    const uid = req.user.user_id;
    const site_id = b.site_id || location_id;
    const out = await tx(async (c) => {
      const scode = await siteCodeOf(site_id);
      const no = await nextNo('JOB', scode, jobcard_date, c);
      const r = await c.query(
        `INSERT INTO tx_jobcard(jobcard_no, jobcard_date, asset_id, location_id, job_type,
             reported_defect, estimated_cost, jobcard_status, opened_at, site_id, created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,'IN_PROGRESS', now(), $8,$9)
         RETURNING jobcard_id, jobcard_no, jobcard_status`,
        [no, jobcard_date, asset_id, location_id, job_type, reported_defect, money(estimated_cost), site_id, uid]);
      return r.rows[0];
    });
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Get one with lines + current cost.
router.get('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const sc = scopeSql(req, 'jc', 2);
    const jc = await one(
      `SELECT jc.*, a.asset_no, a.asset_name FROM tx_jobcard jc JOIN md_asset a ON a.asset_id=jc.asset_id
       WHERE jc.jobcard_id=$1${sc.sql}`, [id, ...sc.params]);
    if (!jc) return res.status(404).json({ error: 'Job card not found' });
    jc.labour = await q(`SELECT jl.labour_id, jl.labour_no, jl.employee_id, e.employee_name, jl.labour_date,
              jl.hours, jl.ot_hours, jl.hourly_rate, jl.labour_cost
       FROM tx_job_labour jl JOIN md_employee e ON e.employee_id=jl.employee_id
       WHERE jl.jobcard_id=$1 AND jl.is_active ORDER BY jl.labour_id`, [id]);
    jc.parts = await q(`SELECT jp.job_part_id, jp.item_id, i.item_no, i.item_name, jp.qty, jp.unit_cost,
              jp.part_cost, jp.is_general, jp.is_provisional, jp.is_returned
       FROM tx_job_parts jp JOIN md_item i ON i.item_id=jp.item_id
       WHERE jp.jobcard_id=$1 AND jp.is_active ORDER BY jp.job_part_id`, [id]);
    jc.cost = await one('SELECT * FROM cost_job_summary WHERE jobcard_id=$1', [id]);
    res.json(jc);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Labour ---------------------------------------------------------------
// Rate is resolved from md_labour_rate by the technician's grade, effective on the labour date.
router.post('/:id/labour', requirePerm('JOB.LABOUR'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const b = req.body || {};
    const { employee_id, hours = 0, ot_hours = 0, labour_date = new Date().toISOString().slice(0, 10) } = b;
    if (!employee_id) return res.status(400).json({ error: 'employee_id required' });
    const jc = await one('SELECT jobcard_id, site_id, jobcard_status FROM tx_jobcard WHERE jobcard_id=$1 AND is_active', [id]);
    if (!jc) return res.status(404).json({ error: 'Job card not found' });
    const emp = await one('SELECT employee_id, grade_id FROM md_employee WHERE employee_id=$1', [employee_id]);
    if (!emp || !emp.grade_id) return res.status(400).json({ error: 'employee has no grade — cannot rate labour' });
    const rate = await one(
      `SELECT labour_rate_id, hourly_rate, ot_multiplier FROM md_labour_rate
       WHERE grade_id=$1 AND effective_date <= $2 AND rate_status='CONFIRMED'
       ORDER BY effective_date DESC LIMIT 1`, [emp.grade_id, labour_date]);
    if (!rate) return res.status(400).json({ error: 'no confirmed labour rate for this grade/date' });
    const labour_cost = money(hours * rate.hourly_rate + ot_hours * rate.hourly_rate * rate.ot_multiplier);
    const uid = req.user.user_id;
    const out = await tx(async (c) => {
      const no = await nextNo('LAB', (await siteCodeOf(jc.site_id)), labour_date, c);
      const r = await c.query(
        `INSERT INTO tx_job_labour(labour_no, jobcard_id, employee_id, labour_date, hours, ot_hours,
             grade_id, labour_rate_id, hourly_rate, labour_cost, doc_status, site_id, created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'CONFIRMED',$11,$12)
         RETURNING labour_id, labour_no, hourly_rate, labour_cost`,
        [no, id, employee_id, labour_date, hours, ot_hours, emp.grade_id, rate.labour_rate_id,
         rate.hourly_rate, labour_cost, jc.site_id, uid]);
      return r.rows[0];
    });
    res.json({ ...out, hourly_rate: Number(out.hourly_rate), labour_cost: Number(out.labour_cost) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- Parts ----------------------------------------------------------------
// A part line. is_general routes to general_cost; is_provisional blocks close until confirmed.
router.post('/:id/parts', requirePerm('JOB.PARTS'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const b = req.body || {};
    const { item_id, qty = 0, unit_cost = 0, is_general = false, is_provisional = false } = b;
    if (!item_id || !(qty > 0)) return res.status(400).json({ error: 'item_id and qty>0 required' });
    const jc = await one('SELECT jobcard_id, site_id FROM tx_jobcard WHERE jobcard_id=$1 AND is_active', [id]);
    if (!jc) return res.status(404).json({ error: 'Job card not found' });
    const item = await one('SELECT item_id, base_uom_id, item_type FROM md_item WHERE item_id=$1', [item_id]);
    if (!item) return res.status(400).json({ error: 'unknown item' });
    const part_cost = money(qty * unit_cost);
    const uid = req.user.user_id;
    const r = await one(
      `INSERT INTO tx_job_parts(jobcard_id, item_id, uom_id, qty, unit_cost, part_cost,
           source_type, is_general, is_provisional, site_id, created_by)
       VALUES($1,$2,$3,$4,$5,$6,'DIRECT',$7,$8,$9,$10)
       RETURNING job_part_id, part_cost, is_general, is_provisional`,
      [id, item_id, item.base_uom_id, qty, unit_cost, part_cost,
       !!is_general || item.item_type === 'GENERAL', !!is_provisional, jc.site_id, uid]);
    res.json({ ...r, part_cost: Number(r.part_cost), is_general: !!r.is_general, is_provisional: !!r.is_provisional });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- Cost roll-up ---------------------------------------------------------
// Sum labour + parts (+ outside repair) into cost_job_summary; compute variance; flag provisional.
router.post('/:id/cost', requirePerm('JOB.COST'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const jc = await one('SELECT jobcard_id, site_id, estimated_cost FROM tx_jobcard WHERE jobcard_id=$1 AND is_active', [id]);
    if (!jc) return res.status(404).json({ error: 'Job card not found' });
    const uid = req.user.user_id;

    const p = await one(`SELECT
        COALESCE(SUM(part_cost) FILTER (WHERE NOT is_general AND NOT is_returned),0) AS material,
        COALESCE(SUM(part_cost) FILTER (WHERE is_general AND NOT is_returned),0) AS general,
        BOOL_OR(is_provisional) FILTER (WHERE NOT is_returned) AS has_prov
      FROM tx_job_parts WHERE jobcard_id=$1 AND is_active`, [id]);
    const l = await one('SELECT COALESCE(SUM(labour_cost),0) AS labour FROM tx_job_labour WHERE jobcard_id=$1 AND is_active', [id]);
    const o = await one("SELECT COALESCE(SUM(actual_cost),0) AS outside FROM tx_job_outside_repair WHERE jobcard_id=$1 AND is_active", [id]);

    const material = money(p.material), general = money(p.general), labour = money(l.labour), outside = money(o.outside);
    const overhead = 0;
    const total = money(material + labour + outside + general + overhead);
    const est = money(jc.estimated_cost);
    const variance = money(total - est);
    const variance_pct = est > 0 ? Math.round((variance / est) * 10000) / 100 : 0;
    const isProv = !!p.has_prov;

    const summary = await tx(async (c) => {
      const r = await c.query(
        `INSERT INTO cost_job_summary(jobcard_id, material_cost, labour_cost, outside_repair_cost,
             general_cost, overhead_cost, total_job_cost, estimated_cost, variance_amt, variance_pct,
             is_provisional, cost_status, calculated_at, site_id, created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'CALCULATED', now(), $12,$13)
         ON CONFLICT (jobcard_id) DO UPDATE SET
             material_cost=EXCLUDED.material_cost, labour_cost=EXCLUDED.labour_cost,
             outside_repair_cost=EXCLUDED.outside_repair_cost, general_cost=EXCLUDED.general_cost,
             total_job_cost=EXCLUDED.total_job_cost, estimated_cost=EXCLUDED.estimated_cost,
             variance_amt=EXCLUDED.variance_amt, variance_pct=EXCLUDED.variance_pct,
             is_provisional=EXCLUDED.is_provisional, cost_status='CALCULATED', calculated_at=now(),
             updated_by=$13, updated_at=now()
         RETURNING *`,
        [id, material, labour, outside, general, overhead, total, est, variance, variance_pct, isProv, jc.site_id, uid]);
      await c.query("UPDATE tx_jobcard SET total_job_cost=$1, jobcard_status='PENDING_CLOSURE', updated_by=$2, updated_at=now() WHERE jobcard_id=$3", [total, uid, id]);
      return r.rows[0];
    });
    res.json({ material_cost: material, labour_cost: labour, outside_repair_cost: outside,
      general_cost: general, total_job_cost: total, estimated_cost: est, variance_amt: variance,
      variance_pct, is_provisional: isProv, summary_id: summary.summary_id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- Close (gated) --------------------------------------------------------
// No close while any cost is provisional or before a cost roll-up exists.
router.post('/:id/close', requirePerm('JOB.CLOSE'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const cost = await one('SELECT cost_status, is_provisional FROM cost_job_summary WHERE jobcard_id=$1', [id]);
    if (!cost || cost.cost_status !== 'CALCULATED') return res.status(409).json({ error: 'Compute the final cost before closing.' });
    if (cost.is_provisional) return res.status(409).json({ error: 'Cannot close: provisional-priced costs pending confirmation.' });
    const uid = req.user.user_id;
    await tx(async (c) => {
      await c.query("UPDATE cost_job_summary SET cost_status='FINALIZED', finalized_by=$1, finalized_at=now() WHERE jobcard_id=$2", [uid, id]);
      await c.query("UPDATE tx_jobcard SET jobcard_status='CLOSED', closed_at=now(), updated_by=$1, updated_at=now() WHERE jobcard_id=$2", [uid, id]);
    });
    res.json({ ok: true, jobcard_status: 'CLOSED' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
