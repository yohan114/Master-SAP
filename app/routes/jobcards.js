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
    const { asset_id, location_id, job_type = 'BREAKDOWN', reported_defect = null, promised_date = null,
            estimated_cost = 0, jobcard_date = new Date().toISOString().slice(0, 10) } = b;
    if (!asset_id || !location_id) return res.status(400).json({ error: 'asset_id and location_id are required' });
    const uid = req.user.user_id;
    const site_id = b.site_id || location_id;
    const out = await tx(async (c) => {
      const scode = await siteCodeOf(site_id);
      const no = await nextNo('JOB', scode, jobcard_date, c);
      const r = await c.query(
        `INSERT INTO tx_jobcard(jobcard_no, jobcard_date, asset_id, location_id, job_type,
             reported_defect, promised_date, estimated_cost, jobcard_status, opened_at, site_id, created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,'PENDING_TM_APPROVAL', now(), $9,$10)
         RETURNING jobcard_id, jobcard_no, jobcard_status`,
        [no, jobcard_date, asset_id, location_id, job_type, reported_defect, promised_date, money(estimated_cost), site_id, uid]);
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
    jc.progress = await q(`SELECT jp.progress_id, jp.progress_date, jp.work_done, jp.pct_complete, jp.hours_spent,
              e.employee_name AS logged_by
       FROM tx_job_progress jp LEFT JOIN md_employee e ON e.employee_id=jp.logged_by_employee_id
       WHERE jp.jobcard_id=$1 AND jp.is_active ORDER BY jp.progress_id`, [id]);
    jc.outside = await q(`SELECT o.osr_id, o.osr_no, o.subcontractor_id, s.supplier_name, o.description,
              o.estimated_cost, o.actual_cost, o.osr_status
       FROM tx_job_outside_repair o JOIN md_supplier s ON s.supplier_id=o.subcontractor_id
       WHERE o.jobcard_id=$1 AND o.is_active ORDER BY o.osr_id`, [id]);
    res.json(jc);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Lifecycle: approvals → start → progress → complete --------------------
// Transport-manager then operational-manager approval (segregation of duties), then workshop
// execution. Each step is gated on the current status so the flow can't be skipped.
async function loadJob(id) { return one('SELECT jobcard_id, jobcard_status, site_id, tm_approved_at, om_approved_at FROM tx_jobcard WHERE jobcard_id=$1 AND is_active', [id]); }

router.post('/:id/approve-tm', requirePerm('JOB.APPROVE_TM'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const jc = await loadJob(id);
    if (!jc) return res.status(404).json({ error: 'Job card not found' });
    if (jc.jobcard_status !== 'PENDING_TM_APPROVAL') return res.status(409).json({ error: `job is ${jc.jobcard_status}; not awaiting TM approval` });
    await q("UPDATE tx_jobcard SET jobcard_status='PENDING_OM_APPROVAL', tm_approved_by=$1, tm_approved_at=now(), updated_by=$1, updated_at=now() WHERE jobcard_id=$2", [req.user.user_id, id]);
    res.json({ jobcard_id: id, jobcard_status: 'PENDING_OM_APPROVAL' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/:id/approve-om', requirePerm('JOB.APPROVE_OM'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const jc = await loadJob(id);
    if (!jc) return res.status(404).json({ error: 'Job card not found' });
    if (jc.jobcard_status !== 'PENDING_OM_APPROVAL') return res.status(409).json({ error: `job is ${jc.jobcard_status}; not awaiting OM approval` });
    await q("UPDATE tx_jobcard SET jobcard_status='APPROVED', om_approved_by=$1, om_approved_at=now(), updated_by=$1, updated_at=now() WHERE jobcard_id=$2", [req.user.user_id, id]);
    res.json({ jobcard_id: id, jobcard_status: 'APPROVED' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/:id/reject', requirePerm('JOB.APPROVE_TM'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const jc = await loadJob(id);
    if (!jc) return res.status(404).json({ error: 'Job card not found' });
    if (!['PENDING_TM_APPROVAL', 'PENDING_OM_APPROVAL'].includes(jc.jobcard_status)) return res.status(409).json({ error: `job is ${jc.jobcard_status}; not pending approval` });
    await q("UPDATE tx_jobcard SET jobcard_status='REJECTED', hold_reason=$1, updated_by=$2, updated_at=now() WHERE jobcard_id=$3", [(req.body || {}).reason || null, req.user.user_id, id]);
    res.json({ jobcard_id: id, jobcard_status: 'REJECTED' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/:id/start', requirePerm('JOB.WRITE'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const jc = await loadJob(id);
    if (!jc) return res.status(404).json({ error: 'Job card not found' });
    if (!['APPROVED', 'ASSIGNED_WORKSHOP', 'ON_HOLD'].includes(jc.jobcard_status)) return res.status(409).json({ error: `job is ${jc.jobcard_status}; must be APPROVED to start` });
    await q("UPDATE tx_jobcard SET jobcard_status='IN_PROGRESS', work_started_at=COALESCE(work_started_at, now()), updated_by=$1, updated_at=now() WHERE jobcard_id=$2", [req.user.user_id, id]);
    res.json({ jobcard_id: id, jobcard_status: 'IN_PROGRESS' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/:id/complete', requirePerm('JOB.WRITE'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const jc = await loadJob(id);
    if (!jc) return res.status(404).json({ error: 'Job card not found' });
    if (!['IN_PROGRESS', 'AWAITING_PARTS', 'AWAITING_OUTSIDE_REPAIR'].includes(jc.jobcard_status)) return res.status(409).json({ error: `job is ${jc.jobcard_status}; not in progress` });
    await q("UPDATE tx_jobcard SET jobcard_status='WORK_COMPLETED', work_completed_at=now(), updated_by=$1, updated_at=now() WHERE jobcard_id=$2", [req.user.user_id, id]);
    res.json({ jobcard_id: id, jobcard_status: 'WORK_COMPLETED' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Daily work-done log.
router.post('/:id/progress', requirePerm('JOB.WRITE'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const b = req.body || {};
    if (!b.work_done) return res.status(400).json({ error: 'work_done is required' });
    const jc = await loadJob(id);
    if (!jc) return res.status(404).json({ error: 'Job card not found' });
    const r = await one(
      `INSERT INTO tx_job_progress(jobcard_id, progress_date, work_done, pct_complete, hours_spent, logged_by_employee_id, status_snapshot, next_action, created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING progress_id, progress_date, work_done, pct_complete, hours_spent`,
      [id, b.progress_date || new Date().toISOString().slice(0, 10), b.work_done, Number(b.pct_complete) || 0, Number(b.hours_spent) || 0,
       b.logged_by_employee_id || null, jc.jobcard_status, b.next_action || null, req.user.user_id]);
    res.json({ ...r, pct_complete: Number(r.pct_complete), hours_spent: Number(r.hours_spent) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Outside / subcontract repairs — a job-card sub-resource. NOTE: this app stores these in
// tx_job_outside_repair (not a "cost_outside_repair" table, which doesn't exist here). Field mapping
// for the request's names: job_card_id → jobcard_id (URL), vendor → subcontractor_id (a md_supplier
// reference; there is no free-text vendor_name column), amount → actual_cost, invoice_ref → invoice_no.
// Every insert/delete re-runs rollupCost so cost_job_summary reflects the new total.

// List all outside-repair entries for a job card.
router.get('/:id/outside-repairs', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const rows = await q(
      `SELECT o.osr_id, o.osr_no, o.jobcard_id, o.subcontractor_id, s.supplier_name, o.description,
              o.actual_cost, o.estimated_cost, o.invoice_no, o.osr_status
       FROM tx_job_outside_repair o JOIN md_supplier s ON s.supplier_id=o.subcontractor_id
       WHERE o.jobcard_id=$1 AND o.is_active ORDER BY o.osr_id`, [id]);
    res.json({ count: rows.length, rows: rows.map((r) => ({ ...r, actual_cost: Number(r.actual_cost) })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Add an outside-repair entry, then re-run the cost roll-up.
router.post('/:id/outside-repairs', requirePerm('JOB.OUTSIDE'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const b = req.body || {};
    const jc = await loadJob(id);
    if (!jc) return res.status(404).json({ error: 'Job card not found' });
    const sub = b.subcontractor_id || (await one('SELECT supplier_id FROM md_supplier WHERE is_active ORDER BY supplier_id LIMIT 1') || {}).supplier_id;
    if (!sub) return res.status(400).json({ error: 'subcontractor_id (a supplier) required' });
    const amount = money(b.amount ?? b.actual_cost ?? 0);
    const uid = req.user.user_id;
    const today = new Date().toISOString().slice(0, 10);
    const out = await tx(async (c) => {
      const no = await nextNo('OSR', await siteCodeOf(jc.site_id), today, c);
      const r = (await c.query(
        `INSERT INTO tx_job_outside_repair(osr_no, jobcard_id, subcontractor_id, description, invoice_no,
             sent_date, expected_return_date, estimated_cost, actual_cost, osr_status, doc_status, site_id, created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'POSTED',$11,$12) RETURNING osr_id, osr_no, actual_cost, osr_status`,
        [no, id, sub, b.description || null, b.invoice_ref || b.invoice_no || null, today, b.expected_return_date || null,
         money(b.estimated_cost || 0), amount, b.osr_status || 'SENT', jc.site_id, uid])).rows[0];
      const cost = await rollupCost(c, id, uid);
      return { ...r, actual_cost: Number(r.actual_cost), total_job_cost: cost.total_job_cost };
    });
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Remove an outside-repair entry (soft delete), then re-run the cost roll-up. Blocked once the job is
// finalized — this app has no "OPEN" status; CLOSED/CANCELLED are the terminal states.
router.delete('/:id/outside-repairs/:osrId', requirePerm('JOB.OUTSIDE'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const osrId = Number(req.params.osrId);
    const jc = await one('SELECT jobcard_id, jobcard_status FROM tx_jobcard WHERE jobcard_id=$1 AND is_active', [id]);
    if (!jc) return res.status(404).json({ error: 'Job card not found' });
    if (['CLOSED', 'CANCELLED'].includes(jc.jobcard_status))
      return res.status(409).json({ error: `job is ${jc.jobcard_status}; outside-repair entries can't be removed after it is finalized` });
    const osr = await one('SELECT osr_id FROM tx_job_outside_repair WHERE osr_id=$1 AND jobcard_id=$2 AND is_active', [osrId, id]);
    if (!osr) return res.status(404).json({ error: 'Outside-repair entry not found' });
    const uid = req.user.user_id;
    const out = await tx(async (c) => {
      await c.query('UPDATE tx_job_outside_repair SET is_active=FALSE, updated_by=$1, updated_at=now() WHERE osr_id=$2', [uid, osrId]);
      const cost = await rollupCost(c, id, uid);
      return { ok: true, removed: osrId, total_job_cost: cost.total_job_cost };
    });
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message }); }
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
// Recompute cost_job_summary from the job's current labour + parts + outside repairs. Runs inside an
// open transaction client `c`; upserts the summary and the job's total (but NOT its workflow status,
// so it's safe to call from sub-resource writes). Returns the computed totals.
async function rollupCost(c, id, uid) {
  const jc = (await c.query('SELECT estimated_cost, site_id FROM tx_jobcard WHERE jobcard_id=$1 AND is_active', [id])).rows[0];
  if (!jc) throw new Error('Job card not found');
  const p = (await c.query(`SELECT
      COALESCE(SUM(part_cost) FILTER (WHERE NOT is_general AND NOT is_returned),0) AS material,
      COALESCE(SUM(part_cost) FILTER (WHERE is_general AND NOT is_returned),0) AS general,
      BOOL_OR(is_provisional) FILTER (WHERE NOT is_returned) AS has_prov
    FROM tx_job_parts WHERE jobcard_id=$1 AND is_active`, [id])).rows[0];
  const l = (await c.query('SELECT COALESCE(SUM(labour_cost),0) AS labour FROM tx_job_labour WHERE jobcard_id=$1 AND is_active', [id])).rows[0];
  const o = (await c.query("SELECT COALESCE(SUM(actual_cost),0) AS outside FROM tx_job_outside_repair WHERE jobcard_id=$1 AND is_active", [id])).rows[0];
  const material = money(p.material), general = money(p.general), labour = money(l.labour), outside = money(o.outside);
  const total = money(material + labour + outside + general);
  const est = money(jc.estimated_cost);
  const variance = money(total - est);
  const variance_pct = est > 0 ? Math.round((variance / est) * 10000) / 100 : 0;
  const isProv = !!p.has_prov;
  const r = (await c.query(
    `INSERT INTO cost_job_summary(jobcard_id, material_cost, labour_cost, outside_repair_cost,
         general_cost, overhead_cost, total_job_cost, estimated_cost, variance_amt, variance_pct,
         is_provisional, cost_status, calculated_at, site_id, created_by)
     VALUES($1,$2,$3,$4,$5,0,$6,$7,$8,$9,$10,'CALCULATED', now(), $11,$12)
     ON CONFLICT (jobcard_id) DO UPDATE SET
         material_cost=EXCLUDED.material_cost, labour_cost=EXCLUDED.labour_cost,
         outside_repair_cost=EXCLUDED.outside_repair_cost, general_cost=EXCLUDED.general_cost,
         total_job_cost=EXCLUDED.total_job_cost, estimated_cost=EXCLUDED.estimated_cost,
         variance_amt=EXCLUDED.variance_amt, variance_pct=EXCLUDED.variance_pct,
         is_provisional=EXCLUDED.is_provisional, cost_status='CALCULATED', calculated_at=now(),
         updated_by=$12, updated_at=now()
     RETURNING summary_id`,
    [id, material, labour, outside, general, total, est, variance, variance_pct, isProv, jc.site_id, uid])).rows[0];
  await c.query('UPDATE tx_jobcard SET total_job_cost=$1, updated_by=$2, updated_at=now() WHERE jobcard_id=$3', [total, uid, id]);
  return { material_cost: material, labour_cost: labour, outside_repair_cost: outside, general_cost: general,
    total_job_cost: total, estimated_cost: est, variance_amt: variance, variance_pct, is_provisional: isProv, summary_id: r.summary_id };
}

// Sum labour + parts (+ outside repair) into cost_job_summary; then flag the job PENDING_CLOSURE.
router.post('/:id/cost', requirePerm('JOB.COST'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const uid = req.user.user_id;
    const out = await tx(async (c) => {
      const cost = await rollupCost(c, id, uid);
      await c.query("UPDATE tx_jobcard SET jobcard_status='PENDING_CLOSURE', updated_by=$1, updated_at=now() WHERE jobcard_id=$2", [uid, id]);
      return cost;
    });
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- Close (gated) --------------------------------------------------------
// No close while any cost is provisional or before a cost roll-up exists.
router.post('/:id/close', requirePerm('JOB.CLOSE'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const jc = await one('SELECT tm_approved_at, om_approved_at FROM tx_jobcard WHERE jobcard_id=$1 AND is_active', [id]);
    if (!jc) return res.status(404).json({ error: 'Job card not found' });
    if (!jc.tm_approved_at || !jc.om_approved_at) return res.status(409).json({ error: 'Cannot close: transport-manager and operational-manager approvals must be complete.' });
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
