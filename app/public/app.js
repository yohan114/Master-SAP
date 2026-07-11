'use strict';
// UMMS unified web UI — a single screen over the four modules, calling the same app APIs.
const $ = (s, r = document) => r.querySelector(s);
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (n) => Number(n || 0).toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const int = (n) => Number(n || 0).toLocaleString('en-LK');
const opt = (arr, v, l) => arr.map((x) => `<option value="${esc(x[v])}">${esc(x[l])}</option>`).join('');

let M = { locations: [], assets: [], employees: [] };   // masters cache
let ME = null;

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}
function toast(msg, bad) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.className = 'toast'), 2600);
}
const can = (p) => ME && (ME.perms.includes('ADMIN.ALL') || ME.perms.includes(p));
const loc0 = () => (M.locations[0] || {}).location_id;

/* ---------- boot ---------- */
async function boot() {
  try { ME = await api('/api/me'); } catch { return showLogin(); }
  M = await api('/api/masters');
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  $('#who').textContent = ME.user.full_name || ME.user.username;
  $('#whoRole').textContent = ME.perms.includes('ADMIN.ALL') ? 'Administrator' : `${ME.perms.length} permissions`;
  $('#navAdmin').classList.toggle('hidden', !can('ADMIN.ALL'));   // Admin tools: system_admin only
  route('dashboard');
}
function showLogin() { $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); }
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault(); $('#loginErr').textContent = '';
  try { await api('/auth/login', { method: 'POST', body: JSON.stringify({ username: $('#u').value, password: $('#p').value }) }); boot(); }
  catch (err) { $('#loginErr').textContent = err.message; }
});
$('#logout').addEventListener('click', async () => { await api('/auth/logout', { method: 'POST' }); location.reload(); });
$('#nav').addEventListener('click', (e) => { const a = e.target.closest('a[data-view]'); if (a) route(a.dataset.view); });

const VIEWS = { dashboard, stores, mrn, purchase, oil, battery, workshop, reports, admin };
const CRUMB = { dashboard: 'Overview', stores: 'Inventory', mrn: 'Requisitions', purchase: 'Procurement', oil: 'Lubricant book', battery: 'Serial lifecycle', workshop: 'Job costing', reports: 'Reports & exports', admin: 'Master data' };
const TITLE = { dashboard: 'Dashboard', stores: 'Stores', mrn: 'Requisitions (MRN)', purchase: 'Purchasing', oil: 'Oil & Lubricant', battery: 'Battery', workshop: 'Workshop', reports: 'Reports', admin: 'Admin — deduplication' };
async function route(v) {
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === v));
  $('#crumb').textContent = CRUMB[v]; $('#title').textContent = TITLE[v]; $('#topActions').innerHTML = '';
  $('#view').innerHTML = '<p class="muted">Loading…</p>';
  try { await VIEWS[v](); } catch (e) { $('#view').innerHTML = `<div class="card"><div class="card-b" style="color:var(--block)">${esc(e.message)}</div></div>`; }
}
function table(cols, rows, opts = {}) {
  const head = cols.map((c) => `<th class="${c.n ? 'n' : ''}">${esc(c.h)}</th>`).join('');
  const body = rows.map((r, i) => `<tr class="${opts.click ? 'clk' : ''}" data-i="${i}">` +
    cols.map((c) => `<td class="${c.n ? 'n' : ''}">${c.r ? c.r(r) : esc(r[c.k] ?? '')}</td>`).join('') + '</tr>').join('');
  const t = h(`<div class="tbl-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body || `<tr><td colspan="${cols.length}" class="muted">No records.</td></tr>`}</tbody></table></div>`);
  if (opts.click) t.querySelectorAll('tbody tr.clk').forEach((tr) => tr.addEventListener('click', () => opts.click(rows[tr.dataset.i])));
  return t;
}
const card = (title, bodyEl, headExtra = '') => {
  const c = h(`<div class="card"><div class="card-h"><h3>${esc(title)}</h3><div>${headExtra}</div></div><div class="card-b"></div></div>`);
  c.querySelector('.card-b').append(bodyEl); return c;
};

/* ---------- dashboard ---------- */
async function dashboard() {
  const k = await api('/api/dashboard/kpis');
  const jobs = (await api('/api/jobcards')).rows;
  const kpis = [
    { l: 'Stock value', v: k.stockValue, money: true, pre: 'LKR' },
    { l: 'Open job cards', v: k.openJobCards },
    { l: 'Pending MRNs', v: k.pendingMRNs },
    { l: 'Reorder alerts', v: k.reorderAlerts, warn: true },
    { l: 'Batteries warranty due', v: k.batteriesWarrantyDue, warn: true },
    { l: 'Lubricant days cover', v: k.lubricantDaysCover, dec: 1 },
    { l: 'Pending pricing', v: k.pendingPricing, warn: true },
  ];
  const v = $('#view'); v.innerHTML = '';
  const row = h(`<div class="kpis">${kpis.map((x, i) =>
    `<div class="kpi"><div class="v${x.warn && Number(x.v) > 0 ? ' warn' : ''}" data-kpi="${i}">${x.pre ? `<small>${x.pre}</small> ` : ''}0</div><div class="l">${esc(x.l)}</div></div>`).join('')}</div>`);
  v.append(row);
  kpis.forEach((x, i) => animateCount(row.querySelector(`[data-kpi="${i}"]`), x));   // count up 0 → real value
  // job cards awaiting THIS user's next action in the approval workflow
  try {
    const mine = (await api('/api/jobcards/pending-my-action')).rows;
    if (mine.length) v.append(card(`Awaiting your action (${mine.length})`, table([
      { h: 'JC Number', k: 'jobcard_no' }, { h: 'Asset', r: (r) => esc(`${r.asset_no} · ${r.asset_name}`) },
      { h: 'Your action', r: (r) => `<span class="pill p-build">${esc(r.action)}</span>` },
      { h: 'Est.', n: true, r: (r) => money(r.estimated_cost) },
    ], mine, { click: (r) => openJob(r.jobcard_id) }), '<span class="pill p-block">action needed</span>'));
  } catch { /* endpoint optional */ }
  v.append(card('Stock movement — last 7 days', sparkline(k.stockTrend || [])));
  await alertsPanel(v);
  v.append(card('Recent job cards', table([
    { h: 'Job No', k: 'jobcard_no' }, { h: 'Asset', r: (r) => esc(`${r.asset_no} · ${r.asset_name}`) },
    { h: 'Type', k: 'job_type' }, { h: 'Status', r: (r) => statusPill(r.jobcard_status) },
    { h: 'Cost', n: true, r: (r) => money(r.total_job_cost) },
  ], jobs.slice(0, 8), { click: (r) => openJob(r.jobcard_id) })));
}
// Count a KPI up from 0 to its real value over ~800ms (ease-out cubic).
function animateCount(el, x, dur = 800) {
  const pre = x.pre ? `<small>${esc(x.pre)}</small> ` : '';
  if (x.v == null) { el.innerHTML = pre + '—'; return; }               // e.g. no lubricant consumption yet
  const target = Number(x.v) || 0;
  const fmt = (val) => x.money ? money(val)
    : x.dec ? (Math.round(val * 10) / 10).toLocaleString('en-LK', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
      : int(Math.round(val));
  const start = performance.now();
  const step = (t) => {
    const p = Math.min(1, (t - start) / dur), e = 1 - Math.pow(1 - p, 3);
    el.innerHTML = pre + fmt(target * e);
    if (p < 1) requestAnimationFrame(step); else el.innerHTML = pre + fmt(target);
  };
  requestAnimationFrame(step);
}
// 7-day net stock-movement sparkline as inline SVG (Chart.js isn't in this project; zero deps).
function sparkline(trend) {
  const W = 720, H = 96, pad = 10;
  const vals = trend.map((t) => Number(t.net) || 0);
  const max = Math.max(1, ...vals.map((n) => Math.abs(n)));
  const x = (i) => pad + i * ((W - 2 * pad) / Math.max(1, trend.length - 1));
  const y = (val) => H / 2 - (val / max) * (H / 2 - pad);
  const pts = vals.map((val, i) => `${x(i).toFixed(1)},${y(val).toFixed(1)}`).join(' ');
  const dots = vals.map((val, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(val).toFixed(1)}" r="3" fill="var(--accent)"><title>${esc(trend[i].date)}: ${int(val)}</title></circle>`).join('');
  const labels = trend.map((t) => `<span class="muted" style="font-size:10px">${esc(String(t.date).slice(5))}</span>`).join('');
  return h(`<div><svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" style="display:block">
      <line x1="${pad}" y1="${H / 2}" x2="${W - pad}" y2="${H / 2}" stroke="var(--line-2)" stroke-width="1" stroke-dasharray="3 3"/>
      <polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>${dots}
    </svg><div class="row" style="justify-content:space-between;margin-top:6px">${labels}</div>
    <div class="muted" style="font-size:11px;margin-top:2px">net stock movement (in − out) per day</div></div>`);
}
function statusPill(s) {
  const cls = s === 'CLOSED' ? 'p-live' : s === 'IN_SERVICE' ? 'p-live' : /HOLD|REJECT|CANCEL/.test(s) ? 'p-block'
    : /PENDING|DRAFT/.test(s) ? 'p-build' : 'p-ready';
  return `<span class="pill ${cls}">${esc(String(s).replace(/_/g, ' ').toLowerCase())}</span>`;
}
// Dashboard exception board — low stock / reorder, lubricant cover, warranty, overdue jobs, pending pricing.
async function alertsPanel(v) {
  let al; try { al = await api('/api/alerts'); } catch { return; }
  const sev = { high: 'p-block', warn: 'p-build', info: 'p-idle' };
  const active = (al.groups || []).filter((g) => g.count > 0);
  const head = h(`<div class="row" style="align-items:center;gap:10px;margin:6px 0 12px"><h3 style="margin:0">Exceptions</h3>
    <span class="pill ${al.total ? 'p-block' : 'p-live'}">${al.total ? al.total + ' to action' : 'all clear'}</span></div>`);
  v.append(head);
  if (!active.length) return;
  active.forEach((g) => {
    const reorderable = (g.key === 'reorder' || g.key === 'below-minimum') && can('STORES.PO');
    const cols = g.columns.map((c) => ({ h: c.h, k: c.k, n: c.n, r: c.n ? (row) => repNum(row[c.k]) : undefined }));
    if (reorderable) cols.push({ h: '', r: (row) => row.item_id ? '<button class="btn sm primary" data-po>Create PO</button>' : '' });
    const tbl = table(cols, g.rows);
    v.append(card(`${g.title}  ·  ${g.count}`, tbl, `<span class="pill ${sev[g.severity] || 'p-idle'}">${esc(g.severity)}</span>`));
    if (reorderable) tbl.querySelectorAll('tbody tr').forEach((tr, i) => {
      const b = tr.querySelector('[data-po]'); if (b) b.onclick = () => createPoFromAlert(g.rows[i], tr);
    });
  });
}
// Reorder quick-action: open a pre-filled draft-PO modal from an alert row (item read-only; site,
// supplier and qty editable). Suggested qty = reorder_qty − on-hand; supplier defaults to the item's
// last PO supplier. On confirm, POST /api/purchase/po (→ DRAFT) and flip the row to "PO raised".
async function createPoFromAlert(row, tr) {
  let last = {}; try { last = await api(`/api/purchase/last-supplier/${row.item_id}`); } catch { /* none on file */ }
  const suggested = Math.max(1, Number(row.reorder_qty ?? row.suggest_order ?? 0) - Number(row.available ?? 0));
  formModal(`Create PO — ${row.item_no}`, [
    { k: 'item', l: 'Item', ro: `${row.item_no} · ${row.item_name}` },
    { k: 'location_id', l: 'Deliver to (site)', sel: opt(M.locations, 'location_id', 'location_name') },
    { k: 'supplier_id', l: 'Supplier', sel: opt(M.suppliers || [], 'supplier_id', 'supplier_name') },
    { k: 'qty', l: 'Order quantity', type: 'number' },
  ], async (d) => {
    if (!(Number(d.qty) > 0)) throw new Error('Order quantity must be greater than 0.');
    const r = await api('/api/purchase/po', { method: 'POST', body: JSON.stringify({
      po_type: 'LOCAL', supplier_id: d.supplier_id, location_id: d.location_id,
      lines: [{ item_id: row.item_id, order_qty: Number(d.qty) }],
    }) });
    toast(`PO ${r.po_no} raised (draft)`);
    const cell = tr.querySelector('td:last-child');
    if (cell) cell.innerHTML = `<span class="pill p-live">PO raised · ${esc(r.po_no)}</span>`;
  }, (form) => {
    form.querySelector('[name=location_id]').value = loc0();
    if (last && last.supplier_id) form.querySelector('[name=supplier_id]').value = last.supplier_id;
    form.querySelector('[name=qty]').value = suggested;
  });
}

/* ---------- stores ---------- */
async function stores() {
  const v = $('#view'); v.innerHTML = '';
  const stock = (await api('/api/stores/stock')).rows;
  const items = (await api('/api/stores/items')).rows;
  const xfers = (await api('/api/transfers')).rows;
  if (can('STORES.RECEIVE')) $('#topActions').append(btn('+ Receive', () => receiveForm(items, 'stores')));
  if (can('STORES.ISSUE')) $('#topActions').append(btn('Issue', () => issueForm(items, 'stores')));
  if (can('STORES.TRANSFER')) $('#topActions').append(btn('Transfer', () => transferForm(items)));
  v.append(card(`On‑hand stock by location (${stock.length})`, table([
    { h: 'Item No', k: 'item_no' }, { h: 'Item', k: 'item_name' }, { h: 'Location', k: 'location_code' },
    { h: 'On hand', n: true, r: (r) => int(r.on_hand_qty) }, { h: 'Avg cost', n: true, r: (r) => money(r.moving_avg_cost) },
    { h: 'Value', n: true, r: (r) => money(r.stock_value) },
  ], stock)));
  v.append(card(`Recent transfers (${xfers.length})`, table([
    { h: 'Transfer No', k: 'transfer_no' }, { h: 'Date', k: 'transfer_date' },
    { h: 'From', k: 'from_name' }, { h: 'To', k: 'to_name' },
    { h: 'Value', n: true, r: (r) => money(r.total_amt) }, { h: 'Status', r: (r) => statusPill(r.doc_status) },
  ], xfers)));
  v.append(card(`Item master (showing ${items.length})`, table([
    { h: 'Item No', k: 'item_no' }, { h: 'Item', k: 'item_name' }, { h: 'Type', k: 'item_type' },
  ], items)));
}
function transferForm(items) {
  formModal('Transfer stock between locations', [
    { k: 'item_id', l: 'Item', sel: opt(items, 'item_id', 'item_name') },
    { k: 'from_location_id', l: 'From location', sel: opt(M.locations, 'location_id', 'location_name') },
    { k: 'to_location_id', l: 'To location', sel: opt(M.locations, 'location_id', 'location_name') },
    { k: 'qty', l: 'Quantity', type: 'number' },
  ], async (d) => { await api('/api/transfers', { method: 'POST', body: JSON.stringify(d) }); toast('Stock transferred'); route('stores'); });
}

/* ---------- requisitions (MRN) ---------- */
async function mrn() {
  const v = $('#view'); v.innerHTML = '';
  const rows = (await api('/api/mrn')).rows;
  if (can('STORES.MRN')) $('#topActions').append(btn('+ New requisition', newMrnForm));
  v.append(card(`Requisitions (${rows.length})`, table([
    { h: 'MRN No', k: 'mrn_no' }, { h: 'Date', k: 'mrn_date' },
    { h: 'Requesting store', k: 'location_name' }, { h: 'Lines', n: true, k: 'lines' },
    { h: 'Status', r: (r) => statusPill(r.doc_status) },
  ], rows, { click: (r) => openMrn(r.mrn_id) })));
}
async function newMrnForm() {
  const items = (await api('/api/stores/items')).rows.filter((i) => i.is_stockable);   // general = stockable master items
  const jobs = (await api('/api/jobcards')).rows;
  const itemOpts = `<option value="">— select stock item —</option>` +
    items.map((i) => `<option value="${i.item_id}">${esc(i.item_no + ' · ' + i.item_name)}</option>`).join('');
  const uomOpts = `<option value="">— unit —</option>` + opt(M.uoms || [], 'uom_id', 'uom_code');
  const catOpts = `<option value="">— category (optional) —</option>` + opt(M.categories || [], 'category_id', 'category_name');
  const lineRow = () => `<div class="mrn-line" style="border:1px solid var(--line);border-radius:8px;padding:10px;margin-bottom:10px">
      <div class="row" style="gap:8px;align-items:center">
        <select name="src" style="flex:0 0 120px"><option value="GENERAL">General</option><option value="OTHER">Other</option></select>
        <span class="gen" style="flex:1"><select name="item" style="width:100%">${itemOpts}</select></span>
        <span class="oth" style="flex:1;display:none"><input name="desc" placeholder="Describe the item" style="width:100%"></span>
        <input name="qty" type="number" placeholder="Qty" style="flex:0 0 74px" min="0" step="any">
        <button type="button" class="btn" data-del>✕</button>
      </div>
      <div class="oth" style="display:none;margin-top:8px">
        <div class="row" style="gap:8px"><select name="uom" style="flex:1">${uomOpts}</select><select name="cat" style="flex:1">${catOpts}</select></div>
        <input name="reason" placeholder="Reason — why it's not a stock item (required)" style="width:100%;margin-top:8px">
      </div></div>`;
  const ov = h(`<div id="login" style="background:rgba(10,14,20,.55)"><form class="login-card" style="width:min(640px,94vw)">
    <div class="brand-row"><h1 style="font-size:16px">New requisition (MRN)</h1></div>
    <label>Requesting store</label><select name="location_id">${opt(M.locations, 'location_id', 'location_name')}</select>
    <label>Against job card (optional)</label><select name="jobcard_id"><option value="">— none —</option>${opt(jobs, 'jobcard_id', 'jobcard_no')}</select>
    <label>Items requested <span class="muted" style="font-weight:400">— General = pick from stock list · Other = type manually</span></label>
    <div id="mrnLines">${lineRow()}${lineRow()}</div>
    <button type="button" class="btn sm" data-add>+ add line</button>
    <div class="row" style="margin-top:20px"><button class="btn primary" type="submit" style="flex:1">Raise MRN</button><button type="button" class="btn" data-x>Cancel</button></div>
    <div class="err"></div></form></div>`);
  document.body.append(ov);
  const form = ov.querySelector('form'); const lines = ov.querySelector('#mrnLines');
  const sync = (row) => { const other = row.querySelector('[name=src]').value === 'OTHER';
    row.querySelectorAll('.gen').forEach((el) => (el.style.display = other ? 'none' : ''));
    row.querySelectorAll('.oth').forEach((el) => (el.style.display = other ? '' : 'none')); };
  ov.querySelector('[data-x]').onclick = () => ov.remove();
  ov.querySelector('[data-add]').onclick = () => { const r = h(lineRow()); lines.append(r); sync(r); };
  lines.addEventListener('change', (e) => { if (e.target.name === 'src') sync(e.target.closest('.mrn-line')); });
  lines.addEventListener('click', (e) => { const d = e.target.closest('[data-del]'); if (d && lines.children.length > 1) d.closest('.mrn-line').remove(); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      location_id: form.querySelector('[name=location_id]').value,
      jobcard_id: form.querySelector('[name=jobcard_id]').value || null,
      lines: [...lines.querySelectorAll('.mrn-line')].map((r) => {
        const qty = Number(r.querySelector('[name=qty]').value);
        if (r.querySelector('[name=src]').value === 'OTHER') return {
          item_source: 'OTHER', description: r.querySelector('[name=desc]').value.trim(), qty,
          uom_id: r.querySelector('[name=uom]').value || null, reason: r.querySelector('[name=reason]').value.trim(),
          suggested_category_id: r.querySelector('[name=cat]').value || null };
        return { item_source: 'GENERAL', item_id: r.querySelector('[name=item]').value, qty };
      }).filter((x) => x.qty > 0 && (x.item_id || x.description)),
    };
    if (!body.lines.length) { form.querySelector('.err').textContent = 'Add at least one item with a quantity.'; return; }
    try { const r = await api('/api/mrn', { method: 'POST', body: JSON.stringify(body) }); ov.remove(); toast('MRN ' + r.mrn_no + ' raised'); openMrn(r.mrn_id); }
    catch (err) { form.querySelector('.err').textContent = err.message; }
  });
}
function mrnAvail(r) {
  if (r.item_source !== 'GENERAL') return '<span class="muted">— n/a —</span>';
  const oh = Number(r.on_hand_qty) || 0, req = Number(r.requested_qty) || 0;
  const floor = Math.max(Number(r.min_qty) || 0, Number(r.reorder_level) || 0);
  const cls = oh <= 0 ? 'p-block' : oh < req ? 'p-build' : oh <= floor ? 'p-idle' : 'p-live';
  return `<span class="pill ${cls}">${int(oh)} avail</span>`;
}
async function openMrn(id) {
  const m = await api('/api/mrn/' + id);
  const v = $('#view'); v.innerHTML = ''; v.append(backBtn('mrn'));
  const bar = h('<div class="row" style="margin-bottom:18px"></div>');
  if (can('STORES.MRN') && m.doc_status === 'DRAFT')
    bar.append(btnP('Approve', async () => { try { await api(`/api/mrn/${id}/approve`, { method: 'POST', body: '{}' }); toast('MRN approved'); openMrn(id); } catch (e) { toast(e.message, true); } }));
  if (can('STORES.ISSUE') && ['APPROVED', 'PARTIAL'].includes(m.doc_status))
    bar.append(btnP('Fulfil from stock', async () => { try { const r = await api(`/api/mrn/${id}/fulfil`, { method: 'POST', body: '{}' }); toast('Fulfilled → ' + r.doc_status.toLowerCase()); openMrn(id); } catch (e) { toast(e.message, true); } }));
  const other = (m.lines || []).filter((l) => l.item_source === 'OTHER').length;
  const info = h(`<div class="row" style="margin-bottom:6px">
    <div><div class="crumb">Requesting store</div><b>${esc(m.location_name)}</b></div>
    <div><div class="crumb">Status</div>${statusPill(m.doc_status)}</div>
    <div><div class="crumb">Job card</div><b>${m.jobcard_id ? '#' + esc(m.jobcard_id) : '—'}</b></div>
    <div><div class="crumb">Other items</div><b>${other}</b></div></div>`);
  const wrap = document.createElement('div'); wrap.append(info, bar);
  v.append(card(esc(m.mrn_no), wrap));
  v.append(card('Lines', table([
    { h: 'Type', r: (r) => `<span class="pill ${r.item_source === 'OTHER' ? 'p-idle' : 'p-ready'}">${r.item_source === 'OTHER' ? 'other' : 'general'}</span>` },
    { h: 'Item', r: (r) => r.item_source === 'OTHER'
        ? `✎ ${esc(r.item_description)}${r.request_reason ? `<div class="muted" style="font-size:11px">${esc(r.request_reason)}</div>` : ''}`
        : esc(`${r.item_no} · ${r.item_name}`) },
    { h: 'Req', n: true, r: (r) => `${int(r.requested_qty)} ${esc(r.uom_code || '')}` },
    { h: 'Appr', n: true, r: (r) => int(r.approved_qty) }, { h: 'Issued', n: true, r: (r) => int(r.issued_qty) },
    { h: 'Availability', r: mrnAvail },
    { h: 'Line', r: (r) => statusPill(r.line_status) },
  ], m.lines)));
}

/* ---------- purchasing (PO → GRN → pending price) ---------- */
async function purchase() {
  const v = $('#view'); v.innerHTML = '';
  const pos = (await api('/api/purchase/po')).rows;
  const pend = (await api('/api/purchase/pending')).rows;
  if (can('STORES.PO')) $('#topActions').append(btn('+ New PO', newPoForm));
  const pendCard = card(`Pending pricing (${pend.length})`, table([
    { h: 'GRN', k: 'grn_no' }, { h: 'Item', r: (r) => esc(`${r.item_no} · ${r.item_name}`) },
    { h: 'Qty', n: true, r: (r) => int(r.received_qty) }, { h: 'Provisional', n: true, r: (r) => money(r.provisional_unit_cost) },
    { h: 'Status', r: (r) => statusPill(r.price_status) },
    { h: '', r: () => can('STORES.PRICE') ? '<button class="btn sm primary" data-confirm>Confirm price</button>' : '' },
  ], pend));
  pendCard.querySelectorAll('tbody tr').forEach((tr, i) => { const bx = tr.querySelector('[data-confirm]'); if (bx) bx.onclick = () => confirmPrice(pend[i]); });
  v.append(pendCard);
  v.append(card(`Purchase orders (${pos.length})`, table([
    { h: 'PO No', k: 'po_no' }, { h: 'Type', r: (r) => esc(String(r.po_type).replace('_', ' ').toLowerCase()) },
    { h: 'Supplier', k: 'supplier_name' }, { h: 'Deliver to', k: 'deliver_to' },
    { h: 'Value', n: true, r: (r) => money(r.total_amt) }, { h: 'Status', r: (r) => statusPill(r.doc_status) },
  ], pos, { click: (r) => openPo(r.po_id) })));
}
async function newPoForm() {
  const items = (await api('/api/stores/items')).rows;
  const itemOpts = `<option value="">— item —</option>` + items.map((i) => `<option value="${i.item_id}">${esc(i.item_no + ' · ' + i.item_name)}</option>`).join('');
  const lineRow = () => `<div class="row po-line" style="gap:8px;margin-bottom:8px">
      <select name="item" style="flex:3">${itemOpts}</select>
      <input name="qty" type="number" placeholder="Order qty" style="flex:1" min="0" step="any">
      <input name="price" type="number" placeholder="Unit price (blank = on receipt)" style="flex:2" min="0" step="any">
      <button type="button" class="btn" data-del>✕</button></div>`;
  const ov = h(`<div id="login" style="background:rgba(10,14,20,.55)"><form class="login-card" style="width:min(680px,94vw)">
    <div class="brand-row"><h1 style="font-size:16px">New purchase order</h1></div>
    <label>Type</label><select name="po_type"><option value="LOCAL">Local purchase</option><option value="HEAD_OFFICE">Head office purchase</option></select>
    <label>Supplier</label><select name="supplier_id">${opt(M.suppliers || [], 'supplier_id', 'supplier_name')}</select>
    <label>Deliver to</label><select name="location_id">${opt(M.locations, 'location_id', 'location_name')}</select>
    <label>Order lines <span class="muted" style="font-weight:400">— leave price blank for price‑on‑receipt</span></label>
    <div id="poLines">${lineRow()}${lineRow()}</div>
    <button type="button" class="btn sm" data-add>+ add line</button>
    <div class="row" style="margin-top:20px"><button class="btn primary" type="submit" style="flex:1">Raise PO</button><button type="button" class="btn" data-x>Cancel</button></div>
    <div class="err"></div></form></div>`);
  document.body.append(ov);
  const form = ov.querySelector('form'); const lines = ov.querySelector('#poLines');
  ov.querySelector('[data-x]').onclick = () => ov.remove();
  ov.querySelector('[data-add]').onclick = () => lines.append(h(lineRow()));
  lines.addEventListener('click', (e) => { const d = e.target.closest('[data-del]'); if (d && lines.children.length > 1) d.closest('.po-line').remove(); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      po_type: form.querySelector('[name=po_type]').value,
      supplier_id: form.querySelector('[name=supplier_id]').value || null,
      location_id: form.querySelector('[name=location_id]').value,
      lines: [...lines.querySelectorAll('.po-line')].map((r) => ({
        item_id: r.querySelector('[name=item]').value, order_qty: Number(r.querySelector('[name=qty]').value),
        unit_price: r.querySelector('[name=price]').value ? Number(r.querySelector('[name=price]').value) : undefined,
      })).filter((x) => x.item_id && x.order_qty > 0),
    };
    if (!body.lines.length) { form.querySelector('.err').textContent = 'Add at least one line with a quantity.'; return; }
    try { const r = await api('/api/purchase/po', { method: 'POST', body: JSON.stringify(body) }); ov.remove(); toast('PO ' + r.po_no + ' raised'); openPo(r.po_id); }
    catch (err) { form.querySelector('.err').textContent = err.message; }
  });
}
function confirmPrice(p) {
  formModal(`Confirm price — ${p.item_no}`, [
    { k: 'unit_cost', l: `Confirmed unit cost (LKR) · provisional was ${money(p.provisional_unit_cost)}`, type: 'number' },
  ], async (d) => { const r = await api(`/api/purchase/pending/${p.pending_id}/confirm`, { method: 'POST', body: JSON.stringify(d) }); toast(`Priced · variance ${money(r.variance_amt)}`); route('purchase'); });
}
async function openPo(id) {
  const p = await api('/api/purchase/po/' + id);
  const v = $('#view'); v.innerHTML = ''; v.append(backBtn('purchase'));
  const bar = h('<div class="row" style="margin-bottom:18px"></div>');
  if (can('STORES.PO') && p.doc_status === 'DRAFT')
    bar.append(btnP('Approve', async () => { try { await api(`/api/purchase/po/${id}/approve`, { method: 'POST', body: '{}' }); toast('PO approved'); openPo(id); } catch (e) { toast(e.message, true); } }));
  if (can('STORES.RECEIVE') && ['APPROVED', 'PARTIAL'].includes(p.doc_status))
    bar.append(btnP('Receive all', async () => { try { const r = await api(`/api/purchase/po/${id}/receive`, { method: 'POST', body: '{}' }); toast('Received → ' + r.po_status.toLowerCase()); openPo(id); } catch (e) { toast(e.message, true); } }));
  const info = h(`<div class="row" style="margin-bottom:6px">
    <div><div class="crumb">Type</div><b>${esc(String(p.po_type).replace('_', ' '))}</b></div>
    <div><div class="crumb">Supplier</div><b>${esc(p.supplier_name)}</b></div>
    <div><div class="crumb">Deliver to</div><b>${esc(p.deliver_to)}</b></div>
    <div><div class="crumb">Status</div>${statusPill(p.doc_status)}</div></div>`);
  const wrap = document.createElement('div'); wrap.append(info, bar);
  v.append(card(esc(p.po_no), wrap));
  v.append(card('Order lines', table([
    { h: 'Item', r: (r) => esc(`${r.item_no} · ${r.item_name}`) },
    { h: 'Ordered', n: true, r: (r) => `${int(r.order_qty)} ${esc(r.uom_code || '')}` },
    { h: 'Received', n: true, r: (r) => int(r.received_qty) },
    { h: 'Unit price', n: true, r: (r) => r.unit_price != null ? money(r.unit_price) : '<span class="muted">on receipt</span>' },
    { h: 'Line', r: (r) => statusPill(r.line_status) },
  ], p.lines)));
}

/* ---------- oil ---------- */
async function oil() {
  const v = $('#view'); v.innerHTML = '';
  const prods = (await api('/api/oil/products')).rows;
  const cons = (await api('/api/oil/consumption')).rows;
  if (can('OIL.RECEIVE')) $('#topActions').append(btn('+ Receive', () => receiveForm(prods, 'oil')));
  if (can('OIL.ISSUE')) $('#topActions').append(btn('Issue to vehicle', () => issueForm(prods, 'oil')));
  v.append(card(`Lubricant products (${prods.length})`, table([
    { h: 'Code', k: 'item_no' }, { h: 'Product', k: 'item_name' },
    { h: 'On hand', n: true, r: (r) => int(r.on_hand_qty) }, { h: 'Avg cost', n: true, r: (r) => money(r.moving_avg_cost) },
  ], prods)));
  v.append(card('Consumption by vehicle', table([
    { h: 'Asset', r: (r) => esc(`${r.asset_no} · ${r.asset_name}`) }, { h: 'Product', k: 'item_name' },
    { h: 'Litres', n: true, r: (r) => int(r.qty_issued) }, { h: 'Value', n: true, r: (r) => money(r.value_issued) },
  ], cons)));
}

/* ---------- battery ---------- */
async function battery() {
  const v = $('#view'); v.innerHTML = '';
  const bats = (await api('/api/battery')).rows;
  if (can('BATTERY.WRITE')) $('#topActions').append(btn('+ Register', registerBattery));
  v.append(card(`Batteries (${bats.length})`, table([
    { h: 'Serial', k: 'battery_serial_no' }, { h: 'Model', k: 'model' },
    { h: 'Status', r: (r) => statusPill(r.battery_status) },
    { h: 'On asset', r: (r) => esc(r.current_asset || '—') }, { h: 'Original', r: (r) => esc(r.original_asset || '—') },
  ], bats, { click: (r) => openBattery(r.battery_id) })));
}
async function openBattery(id) {
  const b = await api('/api/battery/' + id);
  const acts = [];
  if (can('BATTERY.ISSUE') && ['IN_STOCK', 'RETURNED', 'REPAIRED'].includes(b.battery_status)) acts.push(actBtn('Install', () => pickAsset('Install on asset', (a) => doBat(id, 'install', { asset_id: a }))));
  if (can('BATTERY.ISSUE') && b.battery_status === 'IN_SERVICE') acts.push(actBtn('Transfer', () => pickAsset('Transfer to asset', (a) => doBat(id, 'transfer', { asset_id: a }))), actBtn('Return', () => doBat(id, 'return', {})));
  if (can('BATTERY.WRITE') && b.battery_status !== 'SCRAPPED') acts.push(actBtn('Scrap', () => doBat(id, 'scrap', { reason: 'ui' })));
  const info = h(`<div><div class="row" style="margin-bottom:14px">
    <div><div class="crumb">Serial</div><b class="num">${esc(b.battery_serial_no)}</b></div>
    <div><div class="crumb">Status</div>${statusPill(b.battery_status)}</div>
    <div style="margin-left:auto">${''}</div></div></div>`);
  acts.forEach((a) => info.querySelector('.row div:last-child').append(a));
  const hist = table([{ h: '#', k: 'event_seq', n: true }, { h: 'Event', k: 'event_type' }, { h: 'Date', k: 'event_date' },
    { h: 'To status', r: (r) => statusPill(r.to_status) }, { h: 'Doc', k: 'source_doc_no' }], b.history);
  const wrap = document.createElement('div'); wrap.append(info, hist);
  $('#view').innerHTML = ''; $('#view').append(backBtn('battery'), card(`Battery ${b.battery_serial_no} — ${b.model}`, wrap));
}
async function doBat(id, action, body) { try { await api(`/api/battery/${id}/${action}`, { method: 'POST', body: JSON.stringify(body) }); toast(`Battery ${action} done`); openBattery(id); } catch (e) { toast(e.message, true); } }
function registerBattery() {
  const models = null;
  formModal('Register battery', [
    { k: 'serial_no', l: 'Serial number' },
    { k: 'item_id', l: 'Model', sel: `<option value="">—</option>` },
    { k: 'location_id', l: 'Location', sel: opt(M.locations, 'location_id', 'location_name') },
    { k: 'capacity_ah', l: 'Capacity (Ah)', type: 'number' }, { k: 'acquisition_cost', l: 'Cost (LKR)', type: 'number' },
  ], async (d) => { await api('/api/stores/items').then((r) => 0); await api('/api/battery/register', { method: 'POST', body: JSON.stringify(d) }); toast('Battery registered'); route('battery'); },
    async (form) => {
      const items = (await api('/api/stores/items')).rows.filter((i) => i.item_type === 'BATTERY');
      form.querySelector('[name=item_id]').innerHTML = opt(items, 'item_id', 'item_name');
    });
}

/* ---------- workshop ---------- */
const JC_STATUSES = ['PENDING_TM_APPROVAL', 'PENDING_OM_APPROVAL', 'APPROVED', 'IN_PROGRESS',
  'WORK_COMPLETED', 'PENDING_CLOSURE', 'CLOSED', 'ON_HOLD', 'CANCELLED', 'REJECTED'];
async function workshop() {
  const v = $('#view'); v.innerHTML = '';
  const jobs = (await api('/api/jobcards')).rows;
  if (can('JOB.WRITE')) $('#topActions').append(btn('+ New Job Card', newJob));
  // filter bar — status dropdown + created date range
  const filters = h(`<div class="card"><div class="card-b"><div class="row" style="align-items:flex-end">
      <div class="f" style="flex:0 0 210px"><label style="margin:0 0 5px">Status</label>
        <select id="jcStatus"><option value="">All statuses</option>${JC_STATUSES.map((st) => `<option value="${st}">${esc(st.replace(/_/g, ' ').toLowerCase())}</option>`).join('')}</select></div>
      <div><label style="margin:0 0 5px">Created from</label><input type="date" id="jcFrom" style="width:150px"></div>
      <div><label style="margin:0 0 5px">Created to</label><input type="date" id="jcTo" style="width:150px"></div>
      <button class="btn sm" id="jcClear">Clear</button></div></div></div>`);
  v.append(filters);
  const host = h('<div></div>'); v.append(host);
  const cols = [
    { h: 'JC Number', k: 'jobcard_no' },
    { h: 'Asset', r: (r) => esc(`${r.asset_no} · ${r.asset_name}`) },
    { h: 'Status', r: (r) => statusPill(r.jobcard_status) },
    { h: 'Total Cost', n: true, r: (r) => money(r.total_job_cost) },
    { h: 'Created Date', k: 'jobcard_date' },
  ];
  const render = () => {
    const st = $('#jcStatus').value, from = $('#jcFrom').value, to = $('#jcTo').value;
    const rows = jobs.filter((j) => (!st || j.jobcard_status === st)
      && (!from || String(j.jobcard_date) >= from) && (!to || String(j.jobcard_date) <= to));
    host.innerHTML = '';
    host.append(card(`Job cards (${rows.length}${rows.length !== jobs.length ? ' of ' + jobs.length : ''})`,
      table(cols, rows, { click: (r) => openJob(r.jobcard_id) })));
  };
  filters.addEventListener('change', render);
  filters.querySelector('#jcClear').onclick = () => { $('#jcStatus').value = ''; $('#jcFrom').value = ''; $('#jcTo').value = ''; render(); };
  render();
}
function newJob() {
  formModal('New job card', [
    { k: 'asset_id', l: 'Asset', sel: opt(M.assets, 'asset_id', 'asset_no') },
    { k: 'job_type', l: 'Type', sel: ['BREAKDOWN', 'PREVENTIVE', 'ACCIDENT', 'RUNNING_REPAIR', 'INSPECTION', 'GENERAL'].map((t) => `<option>${t}</option>`).join('') },
    { k: 'estimated_cost', l: 'Estimated cost (LKR)', type: 'number' }, { k: 'reported_defect', l: 'Reported defect' },
  ], async (d) => { d.location_id = loc0(); const r = await api('/api/jobcards', { method: 'POST', body: JSON.stringify(d) }); toast('Job ' + r.jobcard_no + ' created'); openJob(r.jobcard_id); });
}
async function doJob(id, action, body = {}) {
  try { const r = await api(`/api/jobcards/${id}/${action}`, { method: 'POST', body: JSON.stringify(body) }); toast(`Job ${action.replace(/-/g, ' ')} ✓`); openJob(id); return r; }
  catch (e) { toast(e.message, true); }
}
async function openJob(id, activeTab) {
  const j = await api('/api/jobcards/' + id);
  const s = j.jobcard_status;
  const finalized = ['CLOSED', 'CANCELLED'].includes(s);
  const v = $('#view'); v.innerHTML = ''; v.append(backBtn('workshop'));

  // two-column: main (header + tabbed labour/parts/outside) | cost-summary sidebar
  const layout = h(`<div style="display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap">
    <div class="jc-main" style="flex:1;min-width:360px"></div>
    <div class="jc-side" style="flex:0 0 300px;min-width:260px"></div></div>`);
  const main = layout.querySelector('.jc-main'); const side = layout.querySelector('.jc-side');
  v.append(layout);

  // --- header: status/asset/meta + lifecycle actions ---
  const info = h(`<div class="row" style="margin-bottom:12px">
    <div><div class="crumb">Status</div>${statusPill(s)}</div>
    <div><div class="crumb">Asset</div><b>${esc(j.asset_no)} · ${esc(j.asset_name)}</b></div>
    <div><div class="crumb">Type</div><b>${esc(j.job_type)}</b></div>
    <div><div class="crumb">Created</div><b>${esc(j.jobcard_date)}</b></div>
    ${j.promised_date ? `<div><div class="crumb">Promised</div><b>${esc(j.promised_date)}</b></div>` : ''}
    ${j.reported_defect ? `<div style="flex-basis:100%"><div class="crumb">Reported defect</div><b>${esc(j.reported_defect)}</b></div>` : ''}</div>`);
  const bar = h('<div class="row" style="flex-wrap:wrap"></div>');
  if (can('JOB.APPROVE_TM') && s === 'PENDING_TM_APPROVAL') bar.append(btnP('TM approve', () => doJob(id, 'approve-tm')));
  if (can('JOB.APPROVE_OM') && s === 'PENDING_OM_APPROVAL') bar.append(btnP('OM approve', () => doJob(id, 'approve-om')));
  if (can('JOB.APPROVE_TM') && ['PENDING_TM_APPROVAL', 'PENDING_OM_APPROVAL'].includes(s)) bar.append(btn('Reject', () => doJob(id, 'reject')));
  if (can('JOB.WRITE') && ['APPROVED', 'ASSIGNED_WORKSHOP', 'ON_HOLD'].includes(s)) bar.append(btnP('Start work', () => doJob(id, 'start')));
  if (can('JOB.WRITE') && ['IN_PROGRESS', 'AWAITING_PARTS', 'AWAITING_OUTSIDE_REPAIR'].includes(s)) {
    bar.append(btn('Log progress', () => progressForm(id))); bar.append(btn('Complete work', () => doJob(id, 'complete')));
  }
  if (can('JOB.COST') && !finalized) bar.append(btn('Compute cost', () => doJob(id, 'cost')));
  const hwrap = document.createElement('div'); hwrap.append(info, bar);
  main.append(card(esc(j.jobcard_no), hwrap));

  // --- tabs: Labour / Parts / Outside Repairs ---
  const TABS = [['labour', 'Labour'], ['parts', 'Parts'], ['outside', 'Outside Repairs']];
  let tab = activeTab || 'labour';
  const tabBar = h(`<div class="tabs">${TABS.map(([k, l]) => `<button class="tab" data-tab="${k}">${l}</button>`).join('')}</div>`);
  const panel = h('<div class="jc-panel"></div>');
  const tabsCard = h('<div class="card"><div class="card-b"></div></div>');
  tabsCard.querySelector('.card-b').append(tabBar, panel); main.append(tabsCard);

  const renderTab = () => {
    tabBar.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    panel.innerHTML = '';
    const add = h('<div class="row" style="margin-bottom:12px"></div>');
    if (tab === 'labour') {
      if (can('JOB.LABOUR') && !finalized) add.append(btn('+ Add labour', () => labourForm(id)));
      panel.append(add, table([
        { h: 'No', k: 'labour_no' }, { h: 'Technician', k: 'employee_name' },
        { h: 'Hrs', n: true, k: 'hours' }, { h: 'OT', n: true, k: 'ot_hours' },
        { h: 'Rate', n: true, r: (r) => money(r.hourly_rate) }, { h: 'Cost', n: true, r: (r) => money(r.labour_cost) },
        { h: '', n: true, r: (r) => (can('JOB.LABOUR') && !finalized) ? `<button class="btn sm" data-del-lab="${r.labour_id}">Remove</button>` : '' },
      ], j.labour));
    } else if (tab === 'parts') {
      if (can('JOB.PARTS') && !finalized) add.append(btn('+ Issue part', () => issueForm([], 'stores', id)));
      panel.append(add, table([
        { h: 'Item', r: (r) => esc(`${r.item_no} · ${r.item_name}`) }, { h: 'Qty', n: true, k: 'qty' },
        { h: 'Unit', n: true, r: (r) => money(r.unit_cost) }, { h: 'Cost', n: true, r: (r) => money(r.part_cost) },
        { h: '', r: (r) => r.is_general ? '<span class="pill p-idle">general</span>' : r.is_provisional ? '<span class="pill p-build">provisional</span>' : '' },
      ], j.parts));
    } else {
      if (can('JOB.OUTSIDE') && !finalized) add.append(btn('+ Add outside repair', () => outsideForm(id)));
      panel.append(add, table([
        { h: 'OSR No', k: 'osr_no' }, { h: 'Vendor', k: 'supplier_name' }, { h: 'Description', r: (r) => esc(r.description || '—') },
        { h: 'Invoice', r: (r) => esc(r.invoice_no || '—') }, { h: 'Amount', n: true, r: (r) => money(r.actual_cost) },
        { h: 'Status', r: (r) => statusPill(r.osr_status) },
        { h: '', n: true, r: (r) => (can('JOB.OUTSIDE') && !finalized) ? `<button class="btn sm" data-del-osr="${r.osr_id}">Remove</button>` : '' },
      ], j.outside || []));
    }
  };
  tabBar.addEventListener('click', (e) => { const t = e.target.closest('.tab'); if (t) { tab = t.dataset.tab; renderTab(); } });
  panel.addEventListener('click', async (e) => {
    const dl = e.target.closest('[data-del-lab]'); const dor = e.target.closest('[data-del-osr]');
    if (dl) { try { await api(`/api/jobcards/${id}/labour/${dl.dataset.delLab}`, { method: 'DELETE' }); toast('Labour removed'); openJob(id, 'labour'); } catch (err) { toast(err.message, true); } }
    if (dor) { try { await api(`/api/jobcards/${id}/outside-repairs/${dor.dataset.delOsr}`, { method: 'DELETE' }); toast('Outside repair removed'); openJob(id, 'outside'); } catch (err) { toast(err.message, true); } }
  });
  renderTab();

  // progress log stays below the tabs
  main.append(card('Progress log', table([{ h: 'Date', k: 'progress_date' }, { h: 'Work done', k: 'work_done' },
    { h: '%', n: true, r: (r) => int(r.pct_complete) }, { h: 'Hrs', n: true, r: (r) => int(r.hours_spent) },
    { h: 'By', r: (r) => esc(r.logged_by || '—') }], j.progress || [])));

  // approval / status audit trail (from hist_jobcard_status)
  main.append(card('Status history', table([
    { h: 'From', r: (r) => r.from_status ? statusPill(r.from_status) : '<span class="muted">— new —</span>' },
    { h: 'To', r: (r) => statusPill(r.to_status) },
    { h: 'By', k: 'changed_by' },
    { h: 'When', r: (r) => esc(String(r.changed_at || '').replace('T', ' ').slice(0, 16)) },
    { h: 'Note', r: (r) => esc(r.note || '') },
  ], j.status_history || [])));

  // --- cost summary sidebar (live compute from /cost-summary) ---
  side.append(await jobCostSidebar(id, s));
}

// Right-sidebar Cost Summary panel: labour / parts / outside subtotals + grand total, and an
// Approve/Close button that stays disabled while any cost is provisional (or approvals/cost are
// outstanding — the real close pre-conditions), with a one-line reason.
async function jobCostSidebar(id, status) {
  let cs; try { cs = await api(`/api/jobcards/${id}/cost-summary`); } catch { return card('Cost Summary', h('<p class="muted">No cost data.</p>')); }
  const line = (l, val, strong) => `<div class="row" style="justify-content:space-between;align-items:baseline;padding:7px 0;${strong ? 'border-top:1px solid var(--line-2);margin-top:4px' : ''}">
    <span class="${strong ? '' : 'muted'}" style="${strong ? 'font-weight:700' : ''}">${esc(l)}</span>
    <span class="num" style="${strong ? 'font-size:16px;font-weight:700' : ''}"><small style="color:var(--ink-3)">LKR</small> ${money(val)}</span></div>`;
  const body = h(`<div>
    ${line('Labour', cs.labour_cost)}
    ${line('Parts', cs.parts_cost)}
    ${line('Outside repair', cs.outside_repair_cost)}
    ${line('Grand total', cs.total_job_cost, true)}
    <div class="muted" style="font-size:11px;margin-top:8px">Estimated LKR ${money(cs.estimated_cost)} · variance ${money(cs.variance_amt)}</div>
    ${cs.is_provisional ? '<div style="margin-top:12px"><span class="pill p-build">provisional prices pending</span></div>' : ''}
    <div class="jc-close" style="margin-top:14px"></div></div>`);
  const closeHost = body.querySelector('.jc-close');
  if (can('JOB.CLOSE')) {
    const blocked = cs.is_provisional || !cs.tm_approved || !cs.om_approved || !cs.cost_calculated || ['CLOSED', 'CANCELLED'].includes(cs.jobcard_status);
    const cb = btnP('Approve / Close job', () => doJob(id, 'close')); cb.classList.add('btn-full'); cb.style.marginTop = '0';
    if (blocked) { cb.disabled = true; cb.style.opacity = '.5'; cb.style.cursor = 'not-allowed'; }
    closeHost.append(cb);
    let why = '';
    if (cs.jobcard_status === 'CLOSED') why = 'Job is closed.';
    else if (cs.jobcard_status === 'CANCELLED') why = 'Job is cancelled.';
    else if (!cs.tm_approved || !cs.om_approved) why = 'Awaiting TM / OM approval.';
    else if (cs.is_provisional) why = 'Confirm provisional part prices to enable close.';
    else if (!cs.cost_calculated) why = 'Run “Compute cost” to enable close.';
    if (why) closeHost.append(h(`<div class="muted" style="font-size:11px;margin-top:6px">${esc(why)}</div>`));
  }
  return card('Cost Summary', body);
}
function progressForm(id) {
  formModal('Log daily progress', [
    { k: 'work_done', l: 'Work done' },
    { k: 'pct_complete', l: '% complete', type: 'number' }, { k: 'hours_spent', l: 'Hours spent', type: 'number' },
  ], async (d) => { await api(`/api/jobcards/${id}/progress`, { method: 'POST', body: JSON.stringify(d) }); toast('Progress logged'); openJob(id); });
}
function outsideForm(id) {
  formModal('Outside / subcontract repair', [
    { k: 'subcontractor_id', l: 'Vendor (subcontractor)', sel: opt(M.suppliers || [], 'supplier_id', 'supplier_name') },
    { k: 'description', l: 'Description' }, { k: 'actual_cost', l: 'Amount (LKR)', type: 'number' },
    { k: 'invoice_no', l: 'Invoice ref (optional)' },
    { k: 'osr_status', l: 'Status', sel: ['SENT', 'IN_PROGRESS', 'RECEIVED', 'INVOICED', 'CLOSED'].map((x) => `<option>${x}</option>`).join('') },
  ], async (d) => { await api(`/api/jobcards/${id}/outside-repairs`, { method: 'POST', body: JSON.stringify(d) }); toast('Outside repair added'); openJob(id, 'outside'); });
}
function labourForm(id) {
  formModal('Add labour', [
    { k: 'employee_id', l: 'Technician', sel: opt(M.employees, 'employee_id', 'employee_name') },
    { k: 'hours', l: 'Hours', type: 'number' }, { k: 'ot_hours', l: 'OT hours', type: 'number' },
  ], async (d) => { await api(`/api/jobcards/${id}/labour`, { method: 'POST', body: JSON.stringify(d) }); toast('Labour added'); openJob(id, 'labour'); });
}

/* ---------- reports & exports ---------- */
const repNum = (x) => (x == null || x === '' ? '' : Number(x).toLocaleString('en-LK', { maximumFractionDigits: 2 }));
async function reports() {
  const v = $('#view'); v.innerHTML = '';
  const cat = (await api('/api/reports')).reports;
  const wrap = h(`<div style="display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap">
    <div class="rep-list" style="flex:0 0 260px;min-width:220px"></div><div class="rep-main" style="flex:1;min-width:340px"></div></div>`);
  const list = wrap.querySelector('.rep-list'); const main = wrap.querySelector('.rep-main');
  const listCard = h('<div class="card"><div class="card-h"><h3>Reports</h3></div><div class="card-b" style="padding:8px"></div></div>');
  const lb = listCard.querySelector('.card-b');
  const sel = (btn) => { lb.querySelectorAll('button').forEach((x) => { x.style.background = 'transparent'; x.style.borderLeft = '3px solid transparent'; }); btn.style.background = 'var(--panel-2)'; btn.style.borderLeft = '3px solid var(--accent)'; };
  cat.forEach((r) => { const b = h(`<button class="btn" style="display:block;width:100%;text-align:left;margin:4px 0;border:none;border-left:3px solid transparent;border-radius:6px;background:transparent">${esc(r.title)}<div class="muted" style="font-size:11px;font-weight:400">${esc(r.desc)}</div></button>`); b.onclick = () => { sel(b); runReport(r, main); }; lb.append(b); });
  list.append(listCard); v.append(wrap);
  if (cat[0]) { sel(lb.querySelector('button')); runReport(cat[0], main); }
}
async function runReport(def, main, range) {
  main.innerHTML = '<p class="muted">Running…</p>';
  const from = (range && range.from) || '1900-01-01', to = (range && range.to) || '2999-12-31';
  const qs = def.dated ? `?from=${from}&to=${to}` : '';
  let rep;
  try { rep = await api(`/api/reports/${def.key}${qs}`); } catch (e) { main.innerHTML = `<div class="card"><div class="card-b" style="color:var(--block)">${esc(e.message)}</div></div>`; return; }
  const cols = rep.columns.map((c) => ({ h: c.h, k: c.k, n: c.n, r: c.n ? (row) => repNum(row[c.k]) : undefined }));
  main.innerHTML = '';
  const head = h(`<div class="row" style="margin-bottom:14px;align-items:flex-end;flex-wrap:wrap;gap:10px">
    <div style="flex:1"><div class="crumb">${esc(rep.title)}</div><b>${rep.rows.length} row(s)</b></div>
    ${def.dated ? `<div><label style="margin:0 0 4px">From</label><input type="date" id="repFrom" value="${from === '1900-01-01' ? '' : from}" style="width:148px"></div>
    <div><label style="margin:0 0 4px">To</label><input type="date" id="repTo" value="${to === '2999-12-31' ? '' : to}" style="width:148px"></div>
    <button class="btn sm" id="repRun">Run</button>` : ''}
    <button class="btn sm primary" id="repCsv">Download CSV</button></div>`);
  main.append(head, card(rep.title, table(cols, rep.rows)));
  if (def.dated) head.querySelector('#repRun').onclick = () => runReport(def, main, { from: $('#repFrom').value || '1900-01-01', to: $('#repTo').value || '2999-12-31' });
  head.querySelector('#repCsv').onclick = () => downloadCsv(rep);
}
function downloadCsv(rep) {
  const cell = (s) => { s = String(s ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = [rep.columns.map((c) => cell(c.h)).join(','), ...rep.rows.map((r) => rep.columns.map((c) => cell(r[c.k])).join(','))].join('\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = `${rep.key}.csv`; a.click(); URL.revokeObjectURL(a.href);
}

/* ---------- admin — item deduplication (system_admin only) ---------- */
async function admin() {
  const v = $('#view'); v.innerHTML = '';
  const data = await api('/api/admin/duplicate-candidates');
  const pairs = data.pairs || [];
  v.append(h(`<p class="muted" style="margin:0 0 14px">Near-duplicate <b>md_item</b> rows — name similarity &gt; ${Math.round((data.threshold || 0.8) * 100)}%.
    Merging reassigns every reference (ledger, GRN/MRN/PO lines, job parts, balances…) to the item you keep, folds stock, and retires the other.
    <span class="muted">Matching engine: ${esc(data.engine === 'sqlite' ? 'JS trigram (SQLite)' : 'pg_trgm (PostgreSQL)')}.</span></p>`));
  const itemCell = (it) => `<div><b>${esc(it.item_no)}</b> · ${esc(it.item_name)}<div class="muted" style="font-size:11px">${esc(it.category || '—')} · on hand ${int(it.stock_qty)}</div></div>`;
  const tbl = table([
    { h: 'Keep (survivor)', r: (p) => itemCell(p.keep) },
    { h: 'Merge → into keep', r: (p) => itemCell(p.merge) },
    { h: 'Similarity', n: true, r: (p) => `${Math.round(p.similarity * 100)}%` },
    { h: '', r: () => '<button class="btn sm primary" data-merge>Merge</button>' },
  ], pairs);
  tbl.querySelectorAll('tbody tr').forEach((tr, i) => { const b = tr.querySelector('[data-merge]'); if (b) b.onclick = () => mergeItems(pairs[i], tr); });
  v.append(card(`Duplicate candidates (${pairs.length})`, tbl));
}
function mergeItems(p, tr) {
  formModal(`Merge — keep ${p.keep.item_no}`, [
    { k: 'keep', l: 'Keep (survivor)', ro: `${p.keep.item_no} · ${p.keep.item_name}  ·  on hand ${int(p.keep.stock_qty)}` },
    { k: 'merge', l: 'Merge & retire', ro: `${p.merge.item_no} · ${p.merge.item_name}  ·  on hand ${int(p.merge.stock_qty)}` },
  ], async () => {
    const r = await api('/api/admin/merge-items', { method: 'POST', body: JSON.stringify({ keepId: p.keep.item_id, mergeId: p.merge.item_id }) });
    toast(`Merged ${p.merge.item_no} → ${p.keep.item_no} · ${r.ledger_reassigned} ledger row(s) moved`);
    if (tr) { tr.style.opacity = '.55'; const cell = tr.querySelector('td:last-child'); if (cell) cell.innerHTML = '<span class="pill p-live">merged</span>'; }
  });
}

/* ---------- shared forms ---------- */
function receiveForm(items, mod) {
  formModal(mod === 'oil' ? 'Receive lubricant' : 'Receive stock', [
    { k: 'item_id', l: 'Item', sel: opt(items, 'item_id', 'item_name') },
    { k: 'location_id', l: 'Location', sel: opt(M.locations, 'location_id', 'location_name') },
    { k: 'qty', l: 'Quantity', type: 'number' }, { k: 'unit_cost', l: 'Unit cost (LKR)', type: 'number' },
  ], async (d) => { await api(`/api/${mod}/receive`, { method: 'POST', body: JSON.stringify(d) }); toast('Received'); route(mod); });
}
async function issueForm(items, mod, jobId) {
  if (!items.length) items = (await api(`/api/${mod === 'oil' ? 'oil/products' : 'stores/items'}`)).rows;
  const fields = [
    { k: 'item_id', l: 'Item', sel: opt(items, 'item_id', 'item_name') },
    { k: 'location_id', l: 'From location', sel: opt(M.locations, 'location_id', 'location_name') },
    { k: 'qty', l: 'Quantity', type: 'number' },
  ];
  if (mod === 'oil' || jobId) fields.push({ k: 'asset_id', l: 'Vehicle / asset', sel: `<option value="">—</option>` + opt(M.assets, 'asset_id', 'asset_no') });
  formModal(jobId ? 'Issue part to job' : `Issue ${mod === 'oil' ? 'lubricant' : 'stock'}`, fields, async (d) => {
    if (jobId) d.jobcard_id = jobId;
    await api(`/api/${mod}/issue`, { method: 'POST', body: JSON.stringify(d) });
    toast('Issued'); jobId ? openJob(jobId, 'parts') : route(mod);
  });
}
function pickAsset(title, cb) { formModal(title, [{ k: 'asset_id', l: 'Asset', sel: opt(M.assets, 'asset_id', 'asset_no') }], (d) => cb(d.asset_id)); }

/* ---------- tiny modal ---------- */
function formModal(title, fields, onSubmit, afterRender) {
  const body = fields.map((f) => `<label>${esc(f.l)}</label>` +
    (f.ro !== undefined ? `<input name="${f.k}" value="${esc(f.ro)}" readonly style="background:var(--panel-2);color:var(--ink-3);cursor:not-allowed">`
      : f.sel !== undefined ? `<select name="${f.k}">${f.sel}</select>`
        : `<input name="${f.k}" type="${f.type || 'text'}">`)).join('');
  const ov = h(`<div id="login" style="background:rgba(10,14,20,.55)"><form class="login-card"><div class="brand-row"><h1 style="font-size:16px">${esc(title)}</h1></div>${body}
    <div class="row" style="margin-top:20px"><button class="btn primary" type="submit" style="flex:1">Save</button><button type="button" class="btn" data-x>Cancel</button></div><div class="err"></div></form></div>`);
  document.body.append(ov);
  const form = ov.querySelector('form');
  ov.querySelector('[data-x]').onclick = () => ov.remove();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = {}; fields.forEach((f) => { const el = form.querySelector(`[name=${f.k}]`); d[f.k] = f.type === 'number' ? Number(el.value) : el.value; });
    try { await onSubmit(d); ov.remove(); } catch (err) { ov.querySelector('.err').textContent = err.message; }
  });
  if (afterRender) afterRender(form);
}
const btn = (label, fn) => { const b = h(`<button class="btn sm">${esc(label)}</button>`); b.onclick = fn; return b; };
const btnP = (label, fn) => { const b = h(`<button class="btn sm primary">${esc(label)}</button>`); b.onclick = fn; return b; };
const actBtn = btn;
const backBtn = (v) => { const b = h('<button class="btn sm" style="margin-bottom:16px">← Back</button>'); b.onclick = () => route(v); return b; };

boot();
