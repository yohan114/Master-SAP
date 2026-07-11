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
  return { status: r.status, cookie };
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
  (SELECT location_id FROM md_location WHERE location_code='ST2') site2`))[0];

console.log('AUTH + RBAC');
const admin = await login('admin', 'ChangeMe@Admin1');
A('admin login 200', admin.status === 200);
const foreman = await login('foreman', 'ChangeMe@Fore1');
const viewer = await login('viewer', 'ChangeMe@View1');
A('viewer CANNOT create a job -> 403', (await api('/api/jobcards', viewer.cookie, 'POST', { asset_id: ids.asset, location_id: ids.site })).status === 403);

console.log('\nJOB FLOW (foreman)');
const job = await api('/api/jobcards', foreman.cookie, 'POST', { asset_id: ids.asset, location_id: ids.site, job_type: 'BREAKDOWN', estimated_cost: 10000, reported_defect: 'Brake failure' });
A('create job -> jobcard_no JOB-HQ-..', job.status === 200 && /^JOB-HQ-\d\d-\d{6}$/.test(job.body.jobcard_no), job.body);
const jid = job.body.jobcard_id;

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

const close = await api(`/api/jobcards/${jid}/close`, foreman.cookie, 'POST');
A('close (no provisional) -> 200 CLOSED', close.status === 200 && close.body.jobcard_status === 'CLOSED', close.body);

console.log('\nPROVISIONAL CLOSE GATING');
const job2 = await api('/api/jobcards', foreman.cookie, 'POST', { asset_id: ids.asset, location_id: ids.site, estimated_cost: 5000 });
const j2 = job2.body.jobcard_id;
await api(`/api/jobcards/${j2}/parts`, foreman.cookie, 'POST', { item_id: ids.spare, qty: 1, unit_cost: 2000, is_provisional: true });
const cost2 = await api(`/api/jobcards/${j2}/cost`, foreman.cookie, 'POST');
A('cost flags is_provisional=true', cost2.body.is_provisional === true, cost2.body);
A('close blocked while provisional -> 409', (await api(`/api/jobcards/${j2}/close`, foreman.cookie, 'POST')).status === 409);

console.log('\nGET job shows lines + cost');
const got = await api(`/api/jobcards/${jid}`, admin.cookie);
A('get job returns labour+parts+cost', got.body.labour.length === 1 && got.body.parts.length === 2 && Number(got.body.cost.total_job_cost) === 8750, { l: got.body.labour?.length, p: got.body.parts?.length, t: got.body.cost?.total_job_cost });

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

await end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
