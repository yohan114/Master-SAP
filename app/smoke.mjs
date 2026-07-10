// End-to-end proof of the Workshop module: login -> create job -> labour -> parts ->
// cost roll-up -> close gating, plus an RBAC check. Requires the server running + seeded.
import pg from 'pg';
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

const pool = new pg.Pool();
const ids = (await pool.query(`SELECT
  (SELECT location_id FROM md_location WHERE location_code='HQ') site,
  (SELECT asset_id FROM md_asset WHERE asset_no='VEH-0001') asset,
  (SELECT item_id FROM md_item WHERE item_no='SP-0001') spare,
  (SELECT item_id FROM md_item WHERE item_no='GN-0001') general,
  (SELECT employee_id FROM md_employee WHERE employee_no='EMP-0001') tech`)).rows[0];

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
A('get job returns labour+parts+cost', got.body.labour.length === 1 && got.body.parts.length === 2 && got.body.cost.total_job_cost === '8750.00', { l: got.body.labour?.length, p: got.body.parts?.length, t: got.body.cost?.total_job_cost });

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

await pool.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
