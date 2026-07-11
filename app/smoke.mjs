// End-to-end proof of the whole platform: login -> create job -> labour -> parts ->
// cost roll-up -> close gating, stores/oil issue-to-job, battery lifecycle, plus RBAC.
// Requires the server running + seeded. Runs on either engine (reads seed ids via the
// app's own data layer, so it needs no direct Postgres connection under SQLite).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { q, end } = require('./db');
const BASE = process.env.BASE || 'http://127.0.0.1:4000';
let pass = 0, fail = 0;
const A = (n, c, g) => { (c ? pass++ : fail++); console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  got=' + JSON.stringify(g)}`); };

async function login(username, password) {
  const r = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const cookie = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  return { status: r.status, cookie, body: await r.json().catch(() => ({})) };
}
async function api(path, cookie, method = 'GET', body) {
  const r = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

const ids = (await q(`SELECT
  (SELECT location_id FROM md_location WHERE location_code='HQ') site,
  (SELECT asset_id FROM md_asset WHERE asset_no='VEH-0001') asset,
  (SELECT item_id FROM md_item WHERE item_no='SP-0001') spare,
  (SELECT item_id FROM md_item WHERE item_no='GN-0001') general,
  (SELECT item_id FROM md_item WHERE item_no='LB-0001') lube,
  (SELECT item_id FROM md_item WHERE item_no='BT-0001') batmodel,
  (SELECT asset_id FROM md_asset WHERE asset_no='VEH-0002') asset2,
  (SELECT employee_id FROM md_employee WHERE employee_no='EMP-0001') tech,
  (SELECT uom_id FROM md_uom WHERE uom_code='NOS') uom,
  (SELECT location_id FROM md_location WHERE location_code='ST2') site2,
  (SELECT supplier_id FROM md_supplier WHERE supplier_no='SUP-0001') supplier`))[0];

console.log('AUTH + RBAC');
const admin = await login('admin', 'ChangeMe@Admin1');
A('admin login 200', admin.status === 200);
const foreman = await login('foreman', 'ChangeMe@Fore1');
const viewer = await login('viewer', 'ChangeMe@View1');
const tm = await login('tm', 'ChangeMe@TM1');   // transport_manager: JOB.APPROVE_TM
const om = await login('om', 'ChangeMe@OM1');    // operations_manager: JOB.APPROVE_OM
A('viewer CANNOT create a job -> 403', (await api('/api/jobcards', viewer.cookie, 'POST', { asset_id: ids.asset, location_id: ids.site })).status === 403);

console.log('\nJOB FLOW (foreman)');
const job = await api('/api/jobcards', foreman.cookie, 'POST', { asset_id: ids.asset, location_id: ids.site, job_type: 'BREAKDOWN', estimated_cost: 10000, reported_defect: 'Brake failure' });
A('create job -> jobcard_no JOB-HQ-.. , starts PENDING_TM_APPROVAL', job.status === 200 && /^JOB-HQ-\d\d-\d{6}$/.test(job.body.jobcard_no) && job.body.jobcard_status === 'PENDING_TM_APPROVAL', job.body);
const jid = job.body.jobcard_id;
A('foreman CANNOT TM-approve (segregation of duties -> 403)', (await api(`/api/jobcards/${jid}/approve-tm`, foreman.cookie, 'POST', {})).status === 403);
A('close blocked before approvals -> 409 (core rule #3)', (await api(`/api/jobcards/${jid}/close`, foreman.cookie, 'POST')).status === 409);
A('TM approve -> PENDING_OM_APPROVAL', (await api(`/api/jobcards/${jid}/approve-tm`, admin.cookie, 'POST', {})).body.jobcard_status === 'PENDING_OM_APPROVAL');
A('OM approve -> APPROVED', (await api(`/api/jobcards/${jid}/approve-om`, admin.cookie, 'POST', {})).body.jobcard_status === 'APPROVED');

const lab = await api(`/api/jobcards/${jid}/labour`, foreman.cookie, 'POST', { employee_id: ids.tech, hours: 8, ot_hours: 2 });
A('labour cost = 8*500 + 2*500*1.5 = 5500', lab.body.labour_cost === 5500, lab.body);

const mat = await api(`/api/jobcards/${jid}/parts`, foreman.cookie, 'POST', { item_id: ids.spare, qty: 2, unit_cost: 1500 });
A('material part cost = 3000', mat.body.part_cost === 3000, mat.body);
const gen = await api(`/api/jobcards/${jid}/parts`, foreman.cookie, 'POST', { item_id: ids.general, qty: 5, unit_cost: 50 });
A('general part routed to general (is_general true), cost 250', gen.body.part_cost === 250 && gen.body.is_general === true, gen.body);

const cost = await api(`/api/jobcards/${jid}/cost`, foreman.cookie, 'POST');
A('roll-up: material 3000 / labour 5500 / general 250 / total 8750',
  cost.body.material_cost === 3000 && cost.body.labour_cost === 5500 && cost.body.general_cost === 250 && cost.body.total_job_cost === 8750, cost.body);
A('variance vs 10000 estimate = -1250 (-12.5%)', cost.body.variance_amt === -1250 && cost.body.variance_pct === -12.5, cost.body);

const csum = await api(`/api/jobcards/${jid}/cost-summary`, admin.cookie);
A('cost-summary (read-only) mirrors the roll-up: labour 5500 / parts 3250 / outside 0 / total 8750',
  csum.body.labour_cost === 5500 && csum.body.parts_cost === 3250 && csum.body.outside_repair_cost === 0 && csum.body.total_job_cost === 8750, csum.body);
A('cost-summary exposes the close-gate flags (approved · not provisional · cost calculated)',
  csum.body.tm_approved === true && csum.body.om_approved === true && csum.body.is_provisional === false && csum.body.cost_calculated === true, csum.body);

const close = await api(`/api/jobcards/${jid}/close`, foreman.cookie, 'POST');
A('close (approved, no provisional) -> 200 CLOSED', close.status === 200 && close.body.jobcard_status === 'CLOSED', close.body);

console.log('\nPROVISIONAL CLOSE GATING');
const job2 = await api('/api/jobcards', foreman.cookie, 'POST', { asset_id: ids.asset, location_id: ids.site, estimated_cost: 5000 });
const j2 = job2.body.jobcard_id;
await api(`/api/jobcards/${j2}/approve-tm`, admin.cookie, 'POST', {});
await api(`/api/jobcards/${j2}/approve-om`, admin.cookie, 'POST', {});
await api(`/api/jobcards/${j2}/parts`, foreman.cookie, 'POST', { item_id: ids.spare, qty: 1, unit_cost: 2000, is_provisional: true });
const cost2 = await api(`/api/jobcards/${j2}/cost`, foreman.cookie, 'POST');
A('cost flags is_provisional=true', cost2.body.is_provisional === true, cost2.body);
A('close blocked while provisional -> 409 (even when fully approved)', (await api(`/api/jobcards/${j2}/close`, foreman.cookie, 'POST')).status === 409);

console.log('\nGET job shows lines + cost');
const got = await api(`/api/jobcards/${jid}`, admin.cookie);
A('get job returns labour+parts+cost', got.body.labour.length === 1 && got.body.parts.length === 2 && Number(got.body.cost.total_job_cost) === 8750, { l: got.body.labour?.length, p: got.body.parts?.length, t: got.body.cost?.total_job_cost });

console.log('\nWORKSHOP LIFECYCLE (TM→OM approval → start → progress → outside repair → complete → close)');
const jobL = await api('/api/jobcards', foreman.cookie, 'POST', { asset_id: ids.asset, location_id: ids.site, estimated_cost: 20000, reported_defect: 'Gearbox overhaul' });
const jL = jobL.body.jobcard_id;
A('cannot start before approval -> 409', (await api(`/api/jobcards/${jL}/start`, foreman.cookie, 'POST', {})).status === 409);
A('TM approve -> PENDING_OM_APPROVAL', (await api(`/api/jobcards/${jL}/approve-tm`, admin.cookie, 'POST', {})).body.jobcard_status === 'PENDING_OM_APPROVAL');
A('OM approve -> APPROVED', (await api(`/api/jobcards/${jL}/approve-om`, admin.cookie, 'POST', {})).body.jobcard_status === 'APPROVED');
A('start work -> IN_PROGRESS', (await api(`/api/jobcards/${jL}/start`, foreman.cookie, 'POST', {})).body.jobcard_status === 'IN_PROGRESS');
const prog = await api(`/api/jobcards/${jL}/progress`, foreman.cookie, 'POST', { work_done: 'Stripped gearbox, inspected bearings', pct_complete: 40, hours_spent: 6 });
A('daily progress log entry added', !!prog.body.progress_id && prog.body.pct_complete === 40, prog.body);
const osr = await api(`/api/jobcards/${jL}/outside-repairs`, foreman.cookie, 'POST', { subcontractor_id: ids.supplier, description: 'Crankshaft grinding', actual_cost: 15000, osr_status: 'RECEIVED' });
A('outside/subcontract repair captured (OSR-.., actual 15000)', /^OSR-HQ-\d\d-\d{6}$/.test(osr.body.osr_no) && osr.body.actual_cost === 15000, osr.body);
await api(`/api/jobcards/${jL}/labour`, foreman.cookie, 'POST', { employee_id: ids.tech, hours: 4 });   // 4*500 = 2000
A('complete work -> WORK_COMPLETED', (await api(`/api/jobcards/${jL}/complete`, foreman.cookie, 'POST', {})).body.jobcard_status === 'WORK_COMPLETED');
const costL = await api(`/api/jobcards/${jL}/cost`, foreman.cookie, 'POST');
A('cost roll-up folds in the outside repair: outside 15000 + labour 2000 = 17000',
  costL.body.outside_repair_cost === 15000 && costL.body.labour_cost === 2000 && costL.body.total_job_cost === 17000, costL.body);
const gotL = await api(`/api/jobcards/${jL}`, admin.cookie);
A('job detail carries 1 progress entry + 1 outside repair', gotL.body.progress.length === 1 && gotL.body.outside.length === 1, { p: gotL.body.progress?.length, o: gotL.body.outside?.length });
A('close (approved + costed) -> CLOSED', (await api(`/api/jobcards/${jL}/close`, foreman.cookie, 'POST')).body.jobcard_status === 'CLOSED');

console.log('\nLABOUR REMOVE (soft-delete + roll-up refresh)');
const jobD = await api('/api/jobcards', foreman.cookie, 'POST', { asset_id: ids.asset, location_id: ids.site, estimated_cost: 4000 });
const jD = jobD.body.jobcard_id;
await api(`/api/jobcards/${jD}/approve-tm`, admin.cookie, 'POST', {});
await api(`/api/jobcards/${jD}/approve-om`, admin.cookie, 'POST', {});
await api(`/api/jobcards/${jD}/labour`, foreman.cookie, 'POST', { employee_id: ids.tech, hours: 3 });        // 3*500 = 1500
const labB = await api(`/api/jobcards/${jD}/labour`, foreman.cookie, 'POST', { employee_id: ids.tech, hours: 5 });  // 5*500 = 2500
const csD = await api(`/api/jobcards/${jD}/cost-summary`, admin.cookie);
A('cost-summary sums both labour lines (1500 + 2500 = 4000)', csD.body.labour_cost === 4000, csD.body);
const delLab = await api(`/api/jobcards/${jD}/labour/${labB.body.labour_id}`, foreman.cookie, 'DELETE');
A('DELETE labour removes the line + re-runs the roll-up (labour back to 1500)',
  delLab.body.total_job_cost === 1500 && (await api(`/api/jobcards/${jD}`, admin.cookie)).body.labour.length === 1, delLab.body);
A('DELETE an already-removed labour line -> 404', (await api(`/api/jobcards/${jD}/labour/${labB.body.labour_id}`, foreman.cookie, 'DELETE')).status === 404);

console.log('\nTWO-LEVEL APPROVAL AUDIT (hist_jobcard_status) + pending-my-action');
// NOTE: this app's approval workflow is PENDING_TM_APPROVAL -> PENDING_OM_APPROVAL -> APPROVED
// -> (cost) PENDING_CLOSURE -> CLOSED, gated by permissions JOB.APPROVE_TM / JOB.APPROVE_OM
// (roles transport_manager / operations_manager). A job is "submitted" at creation.
const jobA = await api('/api/jobcards', foreman.cookie, 'POST', { asset_id: ids.asset, location_id: ids.site, estimated_cost: 8000, reported_defect: 'Clutch replacement' });
const jA = jobA.body.jobcard_id;
A('create logs the opening transition (→ PENDING_TM_APPROVAL) in hist_jobcard_status',
  (await q('SELECT to_status FROM hist_jobcard_status WHERE jobcard_id=$1 ORDER BY jc_status_hist_id', [jA])).map((r) => r.to_status).join() === 'PENDING_TM_APPROVAL');
A('pending-my-action (TM) surfaces the new job as "TM approval"',
  (await api('/api/jobcards/pending-my-action', tm.cookie)).body.rows.some((r) => r.jobcard_id === jA && r.action === 'TM approval'));
A('pending-my-action (OM) does NOT surface a job still awaiting TM',
  !(await api('/api/jobcards/pending-my-action', om.cookie)).body.rows.some((r) => r.jobcard_id === jA));
A('TM approval is permission-gated: foreman (no JOB.APPROVE_TM) -> 403',
  (await api(`/api/jobcards/${jA}/approve-tm`, foreman.cookie, 'POST', {})).status === 403);
await api(`/api/jobcards/${jA}/approve-tm`, tm.cookie, 'POST', {});
A('after TM approval, pending-my-action (OM) surfaces it as "OM approval"',
  (await api('/api/jobcards/pending-my-action', om.cookie)).body.rows.some((r) => r.jobcard_id === jA && r.action === 'OM approval'));
A('after TM approval, pending-my-action (TM) no longer surfaces it',
  !(await api('/api/jobcards/pending-my-action', tm.cookie)).body.rows.some((r) => r.jobcard_id === jA));
await api(`/api/jobcards/${jA}/approve-om`, om.cookie, 'POST', {});
await api(`/api/jobcards/${jA}/labour`, foreman.cookie, 'POST', { employee_id: ids.tech, hours: 2 });
await api(`/api/jobcards/${jA}/cost`, foreman.cookie, 'POST');
const closeA = await api(`/api/jobcards/${jA}/close`, foreman.cookie, 'POST');
A('full happy path (submit→TM→OM→cost→close) -> CLOSED', closeA.body.jobcard_status === 'CLOSED', closeA.body);
const chainA = (await q('SELECT to_status FROM hist_jobcard_status WHERE jobcard_id=$1 ORDER BY jc_status_hist_id', [jA])).map((r) => r.to_status);
A('hist_jobcard_status records the full chain TM→OM→APPROVED→PENDING_CLOSURE→CLOSED',
  JSON.stringify(chainA) === JSON.stringify(['PENDING_TM_APPROVAL', 'PENDING_OM_APPROVAL', 'APPROVED', 'PENDING_CLOSURE', 'CLOSED']), chainA);
A('every history row is stamped with a changer + timestamp',
  (await q('SELECT changed_by, changed_at FROM hist_jobcard_status WHERE jobcard_id=$1', [jA])).every((r) => r.changed_by && r.changed_at));
A('a CLOSED job appears in nobody’s pending-my-action',
  !(await api('/api/jobcards/pending-my-action', om.cookie)).body.rows.some((r) => r.jobcard_id === jA)
  && !(await api('/api/jobcards/pending-my-action', tm.cookie)).body.rows.some((r) => r.jobcard_id === jA));
A('GET job now carries its status_history (5 transitions)',
  (await api(`/api/jobcards/${jA}`, admin.cookie)).body.status_history.length === 5);

console.log('\nONE SYSTEM: stores issue flows into a job cost (MWAC ledger)');
const keeper = await login('keeper', 'ChangeMe@Keep1');
// receive 10 @ 1500 then 10 @ 1700 -> moving-average cost = (15000+17000)/20 = 1600
await api('/api/stores/receive', keeper.cookie, 'POST', { item_id: ids.spare, location_id: ids.site, qty: 10, unit_cost: 1500 });
const rcv = await api('/api/stores/receive', keeper.cookie, 'POST', { item_id: ids.spare, location_id: ids.site, qty: 10, unit_cost: 1700 });
A('MWAC after two receipts = 1600, on hand 20', rcv.body.moving_avg_cost === 1600 && rcv.body.on_hand_qty === 20, rcv.body);

const job3 = await api('/api/jobcards', foreman.cookie, 'POST', { asset_id: ids.asset, location_id: ids.site, estimated_cost: 6000 });
const j3 = job3.body.jobcard_id;
const issue = await api('/api/stores/issue', foreman.cookie, 'POST', { item_id: ids.spare, location_id: ids.site, qty: 3, jobcard_id: j3 });
A('issue 3 at MWAC 1600 -> line 4800, stock falls to 17', issue.body.line_amt === 4800 && issue.body.on_hand_qty === 17, issue.body);
A('issue created a job part on the job card', !!issue.body.job_part_id, issue.body);

const cost3 = await api(`/api/jobcards/${j3}/cost`, foreman.cookie, 'POST');
A('job material cost now = the real issued cost (4800)', cost3.body.material_cost === 4800 && cost3.body.total_job_cost === 4800, cost3.body);

A('over-issue is blocked (insufficient stock)', (await api('/api/stores/issue', foreman.cookie, 'POST', { item_id: ids.spare, location_id: ids.site, qty: 9999, jobcard_id: j3 })).status === 400);

console.log('\nOIL/LUBRICANT MODULE (same engine, consumption by vehicle, stock count)');
// receive 200 L @ 950, issue 40 L to the tipper truck
await api('/api/oil/receive', keeper.cookie, 'POST', { item_id: ids.lube, location_id: ids.site, qty: 200, unit_cost: 950 });
const oIssue = await api('/api/oil/issue', keeper.cookie, 'POST', { item_id: ids.lube, location_id: ids.site, qty: 40, asset_id: ids.asset });
A('oil issue 40L @ 950 -> line 38000, stock 160', oIssue.body.line_amt === 38000 && oIssue.body.on_hand_qty === 160, oIssue.body);
A('oil issue requires an asset (400 without)', (await api('/api/oil/issue', keeper.cookie, 'POST', { item_id: ids.lube, location_id: ids.site, qty: 5 })).status === 400);
A('non-lubricant rejected by oil module (400)', (await api('/api/oil/issue', keeper.cookie, 'POST', { item_id: ids.spare, location_id: ids.site, qty: 1, asset_id: ids.asset })).status === 400);

const cons = await api('/api/oil/consumption', admin.cookie);
const truck = (cons.body.rows || []).find((r) => r.item_no === 'LB-0001');
A('consumption-by-asset shows 40L / LKR 38,000 for the truck', truck && Number(truck.qty_issued) === 40 && Number(truck.value_issued) === 38000, truck);

// physical count finds 155 vs book 160 -> variance -5, auto-adjust
const count = await api('/api/oil/count', keeper.cookie, 'POST', { item_id: ids.lube, location_id: ids.site, counted_qty: 155 });
A('stock count 155 vs book 160 -> variance -5, adjusted', count.body.variance === -5 && count.body.adjusted === true, count.body);

console.log('\nBATTERY MODULE (serial-true lifecycle + history)');
const reg = await api('/api/battery/register', keeper.cookie, 'POST', { serial_no: 'BAT-SN-777', item_id: ids.batmodel, location_id: ids.site, capacity_ah: 150, acquisition_cost: 22000 });
A('register battery -> IN_STOCK', reg.body.battery_status === 'IN_STOCK' && reg.body.battery_id, reg.body);
const bid = reg.body.battery_id;
A('duplicate serial rejected', (await api('/api/battery/register', keeper.cookie, 'POST', { serial_no: 'BAT-SN-777', item_id: ids.batmodel, location_id: ids.site })).status === 400);
A('install on truck -> IN_SERVICE', (await api(`/api/battery/${bid}/install`, foreman.cookie, 'POST', { asset_id: ids.asset })).body.battery_status === 'IN_SERVICE');
A('cannot install an in-service battery again -> 409', (await api(`/api/battery/${bid}/install`, foreman.cookie, 'POST', { asset_id: ids.asset2 })).status === 409);
A('transfer to excavator -> IN_SERVICE on new asset', (await api(`/api/battery/${bid}/transfer`, foreman.cookie, 'POST', { asset_id: ids.asset2 })).body.current_asset_id === Number(ids.asset2));
A('return to store -> IN_STOCK', (await api(`/api/battery/${bid}/return`, foreman.cookie, 'POST', {})).body.battery_status === 'IN_STOCK');
A('scrap -> SCRAPPED', (await api(`/api/battery/${bid}/scrap`, keeper.cookie, 'POST', { reason: 'end of life' })).body.battery_status === 'SCRAPPED');

const hist = await api(`/api/battery/${bid}`, admin.cookie);
const types = (hist.body.history || []).map((h) => h.event_type);
A('full history preserved: RECEIVED→INSTALLED→TRANSFERRED→RETURNED→SCRAPPED',
  JSON.stringify(types) === JSON.stringify(['RECEIVED', 'INSTALLED', 'TRANSFERRED', 'RETURNED', 'SCRAPPED']), types);
A('original vs current asset both preserved (original=truck, current=null after scrap)',
  Number(hist.body.original_asset_id) === Number(ids.asset) && hist.body.current_asset_id === null, { o: hist.body.original_asset_id, c: hist.body.current_asset_id });

console.log('\nMRN (requisition → approve → fulfil from stock)');
// spare stands at 17 on hand @ 1600 at HQ from the stores section above
A('viewer CANNOT raise an MRN -> 403',
  (await api('/api/mrn', viewer.cookie, 'POST', { location_id: ids.site, lines: [{ item_id: ids.spare, qty: 5 }] })).status === 403);
const mrnRaise = await api('/api/mrn', foreman.cookie, 'POST', { location_id: ids.site, lines: [{ item_id: ids.spare, qty: 5 }] });
A('raise MRN -> MRN-HQ-.. DRAFT, 1 line',
  mrnRaise.status === 200 && /^MRN-HQ-\d\d-\d{6}$/.test(mrnRaise.body.mrn_no) && mrnRaise.body.doc_status === 'DRAFT' && mrnRaise.body.lines === 1, mrnRaise.body);
const mrnId = mrnRaise.body.mrn_id;
A('cannot fulfil before approve -> 409', (await api(`/api/mrn/${mrnId}/fulfil`, foreman.cookie, 'POST', {})).status === 409);
const appr = await api(`/api/mrn/${mrnId}/approve`, foreman.cookie, 'POST', {});
A('approve -> APPROVED', appr.body.doc_status === 'APPROVED', appr.body);
const ful = await api(`/api/mrn/${mrnId}/fulfil`, foreman.cookie, 'POST', {});
A('fulfil -> CLOSED, line issued 5 at MWAC',
  ful.body.doc_status === 'CLOSED' && ful.body.lines[0].issued === 5 && ful.body.lines[0].line_amt === 8000 && ful.body.lines[0].line_status === 'CLOSED', ful.body);
const mrnGot = await api(`/api/mrn/${mrnId}`, admin.cookie);
A('MRN line shows issued 5; the fulfilling issue dropped stock 17 -> 12',
  Number(mrnGot.body.lines[0].issued_qty) === 5 && Number(mrnGot.body.lines[0].on_hand_qty) === 12, mrnGot.body.lines?.[0]);

console.log('\nMRN — General vs Other items (stock control on general only; spare now 12)');
A('typing an item that exists in the master as "Other" is blocked',
  (await api('/api/mrn', foreman.cookie, 'POST', { location_id: ids.site,
    lines: [{ item_source: 'OTHER', description: 'Brake Pad Set', qty: 1, uom_id: ids.uom, reason: 'x' }] })).status === 400);
A('other item without a reason -> 400',
  (await api('/api/mrn', foreman.cookie, 'POST', { location_id: ids.site,
    lines: [{ item_source: 'OTHER', description: 'Special seal kit XYZ', qty: 1, uom_id: ids.uom }] })).status === 400);
const mixed = await api('/api/mrn', foreman.cookie, 'POST', { location_id: ids.site, lines: [
  { item_source: 'GENERAL', item_id: ids.spare, qty: 2 },
  { item_source: 'OTHER', description: 'Special seal kit XYZ', qty: 1, uom_id: ids.uom, reason: 'off-catalogue one-time' }] });
A('raise mixed MRN (1 general + 1 other)', mixed.status === 200 && mixed.body.lines === 2 && mixed.body.other_lines === 1, mixed.body);
const mixId = mixed.body.mrn_id;
await api(`/api/mrn/${mixId}/approve`, foreman.cookie, 'POST', {});
const mf = await api(`/api/mrn/${mixId}/fulfil`, foreman.cookie, 'POST', {});
A('fulfil issues the general line only; the other line waits for purchase -> PARTIAL', mf.body.doc_status === 'PARTIAL', mf.body);
const mg = await api(`/api/mrn/${mixId}`, admin.cookie);
const gLine = (mg.body.lines || []).find((l) => l.item_source === 'GENERAL');
const oLine = (mg.body.lines || []).find((l) => l.item_source === 'OTHER');
A('general line issued 2 (stock 12 -> 10), CLOSED', Number(gLine.issued_qty) === 2 && Number(gLine.on_hand_qty) === 10 && gLine.line_status === 'CLOSED', gLine);
A('other line bypassed stock: typed desc + reason, no item_id, PENDING_PO',
  oLine.item_id == null && oLine.item_description === 'Special seal kit XYZ' && !!oLine.request_reason && oLine.line_status === 'PENDING_PO', oLine);

console.log('\nMATERIAL TRANSFER between locations (source down, destination up — core rule #7; spare now 10 @ HQ)');
const xf = await api('/api/transfers', keeper.cookie, 'POST', { item_id: ids.spare, from_location_id: ids.site, to_location_id: ids.site2, qty: 4 });
A('transfer 4 @ MWAC 1600: HQ 10->6, ST2 0->4 @ 1600, value 6400',
  xf.body.from_on_hand === 6 && xf.body.to_on_hand === 4 && xf.body.to_avg_cost === 1600 && xf.body.line_amt === 6400, xf.body);
A('transfer to the same location is rejected (400)',
  (await api('/api/transfers', keeper.cookie, 'POST', { item_id: ids.spare, from_location_id: ids.site, to_location_id: ids.site, qty: 1 })).status === 400);
A('over-transfer blocked by source stock (400)',
  (await api('/api/transfers', keeper.cookie, 'POST', { item_id: ids.spare, from_location_id: ids.site, to_location_id: ids.site2, qty: 9999 })).status === 400);
const xstock = (await api('/api/stores/stock', admin.cookie)).body.rows.filter((r) => r.item_no === 'SP-0001');
A('stock now shows the spare at BOTH locations (HQ 6 + ST2 4)',
  xstock.length === 2 && Number(xstock.reduce((s, r) => s + Number(r.on_hand_qty), 0)) === 10, xstock);

console.log('\nPROCUREMENT (PO → receive/GRN → pending price → confirm/revalue)');
A('viewer CANNOT raise a PO -> 403',
  (await api('/api/purchase/po', viewer.cookie, 'POST', { location_id: ids.site, lines: [{ item_id: ids.general, order_qty: 10, unit_price: 50 }] })).status === 403);
// one priced line (general @ 50) + one price-on-receipt line (battery model, no price)
const po = await api('/api/purchase/po', keeper.cookie, 'POST', { po_type: 'LOCAL', location_id: ids.site, lines: [
  { item_id: ids.general, order_qty: 10, unit_price: 50 },
  { item_id: ids.batmodel, order_qty: 4 }] });
A('raise PO -> PO-HQ-.. DRAFT, 2 lines', po.status === 200 && /^PO-HQ-\d\d-\d{6}$/.test(po.body.po_no) && po.body.doc_status === 'DRAFT' && po.body.lines === 2, po.body);
const poId = po.body.po_id;
A('cannot receive before approve -> 409', (await api(`/api/purchase/po/${poId}/receive`, keeper.cookie, 'POST', {})).status === 409);
A('approve PO -> APPROVED', (await api(`/api/purchase/po/${poId}/approve`, keeper.cookie, 'POST', {})).body.doc_status === 'APPROVED');
const poRcv = await api(`/api/purchase/po/${poId}/receive`, keeper.cookie, 'POST', {});
A('receive both lines -> PO RECEIVED, one priced + one pending', poRcv.body.po_status === 'RECEIVED'
  && poRcv.body.lines.length === 2 && poRcv.body.lines.some((l) => l.priced) && poRcv.body.lines.some((l) => l.pending_id), poRcv.body);
const genStock = (await api('/api/stores/stock', admin.cookie)).body.rows.find((r) => r.item_no === 'GN-0001');
A('priced line valued immediately: general 10 @ 50 = 500', genStock && Number(genStock.on_hand_qty) === 10 && Number(genStock.moving_avg_cost) === 50, genStock);
const pend = (await api('/api/purchase/pending', admin.cookie)).body.rows;
A('pending-price list shows the battery-model line (provisional, unconfirmed)',
  pend.length === 1 && pend[0].item_no === 'BT-0001' && pend[0].price_status === 'PENDING', pend);
const conf = await api(`/api/purchase/pending/${pend[0].pending_id}/confirm`, keeper.cookie, 'POST', { unit_cost: 5000 });
A('confirm price 5000 -> revalue: variance 20000, MWAC 5000', conf.body.variance_amt === 20000 && conf.body.new_avg_cost === 5000, conf.body);
A('pending list is now empty (all confirmed)', (await api('/api/purchase/pending', admin.cookie)).body.rows.length === 0);

console.log('\nREPORTS & EXPORTS');
const cat = (await api('/api/reports', admin.cookie)).body.reports;
A('report catalogue lists 13+ reports', Array.isArray(cat) && cat.length >= 13, cat?.length);
const runRep = async (k, qs = '') => (await api(`/api/reports/${k}${qs}`, admin.cookie)).body;
const led = await runRep('stock-ledger');
A('stock-ledger returns columns + movement rows', led.columns.length > 0 && led.rows.length > 0, { c: led.columns?.length, r: led.rows?.length });
const bal = await runRep('stock-balance');
A('stock-balance returns on-hand rows with value', bal.rows.length > 0 && bal.rows.every((r) => 'stock_value' in r), bal.rows?.length);
const jcr = await runRep('job-costing');
A('job-costing includes a costed job (total>0)', jcr.rows.some((r) => Number(r.total_job_cost) > 0), jcr.rows?.length);
const sup = await runRep('supplier-spend');
A('supplier-spend aggregates GRN value by supplier', sup.rows.length > 0 && sup.rows.some((r) => Number(r.total_received) > 0), sup.rows);
const bl = await runRep('battery-lifecycle');
A('battery-lifecycle returns the serial event history', bl.rows.length >= 5, bl.rows?.length);
const aud = await runRep('audit-trail');
A('audit-trail shows who posted each movement', aud.rows.length > 0 && aud.rows.some((r) => r.posted_by), aud.rows?.[0]);
A('unknown report -> 404', (await api('/api/reports/does-not-exist', admin.cookie)).status === 404);

console.log('\nALERTS & REORDER ENGINE');
// force exception conditions: an overdue job, an expired-warranty battery, and a near-empty lubricant
await api('/api/jobcards', foreman.cookie, 'POST', { asset_id: ids.asset, location_id: ids.site, estimated_cost: 500, promised_date: '2020-01-01' });
await api('/api/battery/register', keeper.cookie, 'POST', { serial_no: 'BAT-WAR-EXP', item_id: ids.batmodel, location_id: ids.site, warranty_end_date: '2020-06-01' });
await api('/api/oil/issue', keeper.cookie, 'POST', { item_id: ids.lube, location_id: ids.site, qty: 150, asset_id: ids.asset });
const al = (await api('/api/alerts', admin.cookie)).body;
const grp = (k) => al.groups.find((g) => g.key === k) || { count: 0, rows: [] };
A('below-minimum flags GN-0001 (10 ≤ min 20)', grp('below-minimum').rows.some((r) => r.item_no === 'GN-0001'), grp('below-minimum').rows);
A('reorder flags SP-0001 (10 ≤ reorder 15, above min 8)', grp('reorder').rows.some((r) => r.item_no === 'SP-0001'), grp('reorder').rows);
A('lubricant days-of-cover flags LB-0001 running low', grp('lubricant').rows.some((r) => r.item_no === 'LB-0001' && Number(r.days_left) < 14), grp('lubricant').rows);
A('battery warranty flags the expired battery', grp('battery-warranty').rows.some((r) => r.battery_serial_no === 'BAT-WAR-EXP' && r.state === 'EXPIRED'), grp('battery-warranty').rows);
A('overdue job card flagged (promised 2020-01-01)', grp('overdue-jobs').count >= 1, grp('overdue-jobs').rows);
A('pending-pricing group present in the board', al.groups.some((g) => g.key === 'pending-pricing'));
A('total exception count > 0', al.total > 0, al.total);

console.log('\nREORDER → CREATE-PO QUICK ACTION (alert board → draft PO)');
const reorderRow = grp('reorder').rows.find((r) => r.item_no === 'SP-0001') || grp('reorder').rows[0] || grp('below-minimum').rows[0];
A('reorder alert rows carry item_id + reorder_qty for the quick action',
  !!(reorderRow && reorderRow.item_id && reorderRow.reorder_qty != null), reorderRow);
const lastSup = await api(`/api/purchase/last-supplier/${reorderRow.item_id}`, admin.cookie);
A('last-supplier lookup returns 200 (a supplier, or {} when none on file)', lastSup.status === 200, lastSup.body);
const suggestQty = Math.max(1, Number(reorderRow.reorder_qty) - Number(reorderRow.available));   // reorder_qty − on-hand
const poQA = await api('/api/purchase/po', keeper.cookie, 'POST',
  { po_type: 'LOCAL', supplier_id: ids.supplier, location_id: ids.site, lines: [{ item_id: reorderRow.item_id, order_qty: suggestQty }] });
A('quick-action POST /api/purchase/po creates a DRAFT PO (PO-.., 1 line) for the alert item',
  poQA.status === 200 && /^PO-/.test(poQA.body.po_no) && poQA.body.doc_status === 'DRAFT' && poQA.body.lines === 1, poQA.body);
const poQAview = await api(`/api/purchase/po/${poQA.body.po_id}`, admin.cookie);
A('the draft PO line is the reordered item at the suggested qty',
  poQAview.body.lines.length === 1 && poQAview.body.lines[0].item_id === reorderRow.item_id && Number(poQAview.body.lines[0].order_qty) === suggestQty, poQAview.body.lines);
A('quick action is permission-gated: viewer (no STORES.PO) -> 403',
  (await api('/api/purchase/po', viewer.cookie, 'POST', { po_type: 'LOCAL', supplier_id: ids.supplier, location_id: ids.site, lines: [{ item_id: reorderRow.item_id, order_qty: 1 }] })).status === 403);

console.log('\nOUTSIDE-REPAIR SUB-RESOURCE (POST / GET / DELETE + auto cost roll-up)');
const jOR = (await api('/api/jobcards', foreman.cookie, 'POST', { asset_id: ids.asset, location_id: ids.site, estimated_cost: 10000 })).body.jobcard_id;
await api(`/api/jobcards/${jOR}/approve-tm`, admin.cookie, 'POST', {});
await api(`/api/jobcards/${jOR}/approve-om`, admin.cookie, 'POST', {});
const orPost = await api(`/api/jobcards/${jOR}/outside-repairs`, foreman.cookie, 'POST', { subcontractor_id: ids.supplier, description: 'Turbo recon', amount: 3000, invoice_ref: 'INV-77' });
A('POST outside-repairs inserts and re-runs the roll-up (total_job_cost = 3000)',
  orPost.status === 200 && !!orPost.body.osr_id && orPost.body.total_job_cost === 3000, orPost.body);
const orList = await api(`/api/jobcards/${jOR}/outside-repairs`, foreman.cookie);
A('GET outside-repairs lists the entry', orList.body.count === 1 && orList.body.rows[0].osr_id === orPost.body.osr_id && orList.body.rows[0].actual_cost === 3000, orList.body);
const orDel = await api(`/api/jobcards/${jOR}/outside-repairs/${orPost.body.osr_id}`, foreman.cookie, 'DELETE');
A('DELETE outside-repairs removes it and re-runs the roll-up (total back to 0)',
  orDel.body.total_job_cost === 0 && (await api(`/api/jobcards/${jOR}/outside-repairs`, foreman.cookie)).body.count === 0, orDel.body);

console.log('\nDASHBOARD KPIs (consolidated endpoint + 7-day trend)');
const kp = (await api('/api/dashboard/kpis', admin.cookie)).body;
A('kpis returns all 7 requested fields', ['stockValue', 'openJobCards', 'pendingMRNs', 'reorderAlerts', 'batteriesWarrantyDue', 'lubricantDaysCover', 'pendingPricing'].every((f) => f in kp), Object.keys(kp));
A('stockValue is a positive number', typeof kp.stockValue === 'number' && kp.stockValue > 0, kp.stockValue);
A('openJobCards counts non-terminal jobs (≥1)', typeof kp.openJobCards === 'number' && kp.openJobCards >= 1, kp.openJobCards);
A('reorderAlerts flags low items (≥1)', kp.reorderAlerts >= 1, kp.reorderAlerts);
A('batteriesWarrantyDue flags the expired battery (≥1)', kp.batteriesWarrantyDue >= 1, kp.batteriesWarrantyDue);
A('stockTrend is a dense 7-day {date,net} series', Array.isArray(kp.stockTrend) && kp.stockTrend.length === 7 && 'date' in kp.stockTrend[0] && 'net' in kp.stockTrend[0], kp.stockTrend?.length);

console.log('\nADMIN — ITEM DEDUPLICATION (duplicate-candidates + merge-items)');
const admUid = (await q("SELECT user_id FROM sec_user WHERE username='admin'"))[0].user_id;
// seed a same-named duplicate of SP-0001 'Brake Pad Set'
await q(`INSERT INTO md_item(item_no, item_name, item_type, base_uom_id, created_by)
         VALUES('SP-DUP','Brake Pad Set','SPARE',$1,$2)`, [ids.uom, admUid]);
const dupId = (await q("SELECT item_id FROM md_item WHERE item_no='SP-DUP'"))[0].item_id;
const cand = await api('/api/admin/duplicate-candidates', admin.cookie);
A('duplicate-candidates surfaces the SP-0001 ~ SP-DUP name match',
  cand.status === 200 && cand.body.pairs.some((p) => [p.keep.item_id, p.merge.item_id].includes(dupId) && [p.keep.item_id, p.merge.item_id].includes(ids.spare)), cand.body);
A('duplicate-candidates is admin-only (foreman -> 403)', (await api('/api/admin/duplicate-candidates', foreman.cookie)).status === 403);
// give the duplicate real ledger history, then merge it into SP-0001
await api('/api/stores/receive', keeper.cookie, 'POST', { item_id: dupId, location_id: ids.site, qty: 5, unit_cost: 100 });
const dupLedBefore = Number((await q('SELECT COUNT(*) AS n FROM mv_stock_ledger WHERE item_id=$1', [dupId]))[0].n);
const keepLedBefore = Number((await q('SELECT COUNT(*) AS n FROM mv_stock_ledger WHERE item_id=$1', [ids.spare]))[0].n);
A('the duplicate has ≥1 ledger row before merge', dupLedBefore >= 1, dupLedBefore);
const merged = await api('/api/admin/merge-items', admin.cookie, 'POST', { keepId: ids.spare, mergeId: dupId });
A('merge-items 200 and reports the ledger rows moved', merged.status === 200 && merged.body.ledger_reassigned === dupLedBefore, merged.body);
A('merge reassigns ledger rows: mergeId → 0, keepId gains them',
  Number((await q('SELECT COUNT(*) AS n FROM mv_stock_ledger WHERE item_id=$1', [dupId]))[0].n) === 0 &&
  Number((await q('SELECT COUNT(*) AS n FROM mv_stock_ledger WHERE item_id=$1', [ids.spare]))[0].n) === keepLedBefore + dupLedBefore, merged.body);
A('the merged item is soft-deleted (is_active=false)', !(await q('SELECT is_active FROM md_item WHERE item_id=$1', [dupId]))[0].is_active);
A('the duplicate’s stock balance was folded into keep (0 balance rows left)',
  Number((await q('SELECT COUNT(*) AS n FROM inv_stock_balance WHERE item_id=$1', [dupId]))[0].n) === 0);
A('merge-items is admin-only (foreman -> 403)', (await api('/api/admin/merge-items', foreman.cookie, 'POST', { keepId: ids.spare, mergeId: dupId })).status === 403);

console.log('\nSECURITY — force password change + login audit + lockout');
A('login flags must_change_password for a seeded (default-password) account', admin.body.must_change_password === true, admin.body);
// change-password validation + rotation (on viewer; not used after this)
A('change-password rejects a wrong current password -> 400',
  (await api('/api/auth/change-password', viewer.cookie, 'POST', { current_password: 'nope', new_password: 'ViewerNew@2026' })).status === 400);
A('change-password enforces the complexity policy (weak new password -> 400)',
  (await api('/api/auth/change-password', viewer.cookie, 'POST', { current_password: 'ChangeMe@View1', new_password: 'weak' })).status === 400);
A('change-password accepts a valid rotation -> 200',
  (await api('/api/auth/change-password', viewer.cookie, 'POST', { current_password: 'ChangeMe@View1', new_password: 'ViewerNew@2026' })).status === 200);
A('the old password no longer works -> 401', (await login('viewer', 'ChangeMe@View1')).status === 401);
const relog = await login('viewer', 'ViewerNew@2026');
A('the new password works and must_change_password is now false', relog.status === 200 && relog.body.must_change_password === false, relog.body);
// brute-force lockout (on keeper; not used after this): 5 failures within the window -> 429
let lastAttempt;
for (let i = 0; i < 5; i++) lastAttempt = await login('keeper', 'WRONG-PASSWORD');
A('the 5th failed attempt trips the lockout -> 429', lastAttempt.status === 429, lastAttempt.status);
A('a locked account is refused even with the correct password -> 429', (await login('keeper', 'ChangeMe@Keep1')).status === 429);
// login audit (admin-only)
const la = await api('/api/admin/login-audit?limit=10', admin.cookie);
A('login-audit returns a paginated attempt history for admin',
  la.status === 200 && la.body.total > 0 && Array.isArray(la.body.rows) && la.body.rows.length > 0 && 'success' in la.body.rows[0], la.body?.total);
A('login-audit records both successes and failures', la.body.rows.some((r) => r.success) && (await api('/api/admin/login-audit?limit=200', admin.cookie)).body.rows.some((r) => r.success === false));
A('login-audit is admin-only (foreman -> 403)', (await api('/api/admin/login-audit', foreman.cookie)).status === 403);

await end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
