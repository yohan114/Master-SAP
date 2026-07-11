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

const VIEWS = { dashboard, stores, mrn, purchase, oil, battery, workshop };
const CRUMB = { dashboard: 'Overview', stores: 'Inventory', mrn: 'Requisitions', purchase: 'Procurement', oil: 'Lubricant book', battery: 'Serial lifecycle', workshop: 'Job costing' };
const TITLE = { dashboard: 'Dashboard', stores: 'Stores', mrn: 'Requisitions (MRN)', purchase: 'Purchasing', oil: 'Oil & Lubricant', battery: 'Battery', workshop: 'Workshop' };
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
  const s = await api('/api/summary');
  const jobs = (await api('/api/jobcards')).rows;
  const kpis = [
    ['Stores items', int(s.stores_items)], ['Oil products', int(s.oil_products)],
    ['Fleet assets', int(s.assets)], ['Batteries', `${int(s.batteries)} <small>/ ${int(s.batteries_in_service)} fitted</small>`],
    ['Open MRNs', int(s.mrns_open)], ['Open POs', int(s.pos_open)],
    ['Pending pricing', int(s.pending_pricing)], ['Open jobs', int(s.jobs_open)],
    ['Stock value', `<small>LKR</small> ${money(s.stock_value)}`],
  ];
  const v = $('#view'); v.innerHTML = '';
  v.append(h(`<div class="kpis">${kpis.map((k) => `<div class="kpi"><div class="v">${k[1]}</div><div class="l">${k[0]}</div></div>`).join('')}</div>`));
  v.append(card('Recent job cards', table([
    { h: 'Job No', k: 'jobcard_no' }, { h: 'Asset', r: (r) => esc(`${r.asset_no} · ${r.asset_name}`) },
    { h: 'Type', k: 'job_type' }, { h: 'Status', r: (r) => statusPill(r.jobcard_status) },
    { h: 'Cost', n: true, r: (r) => money(r.total_job_cost) },
  ], jobs.slice(0, 8), { click: (r) => openJob(r.jobcard_id) })));
}
function statusPill(s) {
  const cls = s === 'CLOSED' ? 'p-live' : s === 'IN_SERVICE' ? 'p-live' : /HOLD|REJECT|CANCEL/.test(s) ? 'p-block'
    : /PENDING|DRAFT/.test(s) ? 'p-build' : 'p-ready';
  return `<span class="pill ${cls}">${esc(String(s).replace(/_/g, ' ').toLowerCase())}</span>`;
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
async function workshop() {
  const v = $('#view'); v.innerHTML = '';
  const jobs = (await api('/api/jobcards')).rows;
  if (can('JOB.WRITE')) $('#topActions').append(btn('+ New job card', newJob));
  v.append(card(`Job cards (${jobs.length})`, table([
    { h: 'Job No', k: 'jobcard_no' }, { h: 'Asset', r: (r) => esc(`${r.asset_no} · ${r.asset_name}`) },
    { h: 'Type', k: 'job_type' }, { h: 'Status', r: (r) => statusPill(r.jobcard_status) },
    { h: 'Est.', n: true, r: (r) => money(r.estimated_cost) }, { h: 'Actual', n: true, r: (r) => money(r.total_job_cost) },
  ], jobs, { click: (r) => openJob(r.jobcard_id) })));
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
async function openJob(id) {
  const j = await api('/api/jobcards/' + id);
  const c = j.cost || {};
  const s = j.jobcard_status;
  const kpis = [['Material', c.material_cost], ['Labour', c.labour_cost], ['General', c.general_cost], ['Outside', c.outside_repair_cost], ['Total', c.total_job_cost || j.total_job_cost]];
  const v = $('#view'); v.innerHTML = ''; v.append(backBtn('workshop'));
  const head = h(`<div class="kpis">${kpis.map((k) => `<div class="kpi"><div class="v"><small>LKR</small> ${money(k[1])}</div><div class="l">${k[0]}</div></div>`).join('')}</div>`);
  v.append(head);
  const bar = h('<div class="row" style="margin-bottom:18px;flex-wrap:wrap"></div>');
  // lifecycle (status-aware): TM approve -> OM approve -> start -> progress/complete
  if (can('JOB.APPROVE_TM') && s === 'PENDING_TM_APPROVAL') bar.append(btnP('TM approve', () => doJob(id, 'approve-tm')));
  if (can('JOB.APPROVE_OM') && s === 'PENDING_OM_APPROVAL') bar.append(btnP('OM approve', () => doJob(id, 'approve-om')));
  if (can('JOB.WRITE') && ['APPROVED', 'ASSIGNED_WORKSHOP', 'ON_HOLD'].includes(s)) bar.append(btnP('Start work', () => doJob(id, 'start')));
  if (can('JOB.WRITE') && ['IN_PROGRESS', 'AWAITING_PARTS', 'AWAITING_OUTSIDE_REPAIR'].includes(s)) {
    bar.append(btn('Log progress', () => progressForm(id))); bar.append(btn('Complete work', () => doJob(id, 'complete')));
  }
  if (can('JOB.LABOUR')) bar.append(btn('+ Labour', () => labourForm(id)));
  if (can('JOB.PARTS')) bar.append(btn('+ Part (issue)', () => issueForm([], 'stores', id)));
  if (can('JOB.OUTSIDE')) bar.append(btn('+ Outside repair', () => outsideForm(id)));
  if (can('JOB.COST')) bar.append(btn('Compute cost', () => doJob(id, 'cost')));
  if (can('JOB.CLOSE')) bar.append(btnP('Close job', () => doJob(id, 'close')));
  const info = h(`<div class="row" style="margin-bottom:12px">
    <div><div class="crumb">Status</div>${statusPill(s)}</div>
    <div><div class="crumb">Asset</div><b>${esc(j.asset_no)} · ${esc(j.asset_name)}</b></div>
    <div><div class="crumb">Type</div><b>${esc(j.job_type)}</b></div>
    ${j.promised_date ? `<div><div class="crumb">Promised</div><b>${esc(j.promised_date)}</b></div>` : ''}</div>`);
  const wrap = document.createElement('div'); wrap.append(info, bar);
  v.append(card(esc(j.jobcard_no), wrap));
  v.append(card('Labour', table([{ h: 'No', k: 'labour_no' }, { h: 'Technician', k: 'employee_name' }, { h: 'Hrs', n: true, k: 'hours' }, { h: 'OT', n: true, k: 'ot_hours' }, { h: 'Rate', n: true, r: (r) => money(r.hourly_rate) }, { h: 'Cost', n: true, r: (r) => money(r.labour_cost) }], j.labour)));
  v.append(card('Parts', table([{ h: 'Item', k: 'item_name' }, { h: 'Qty', n: true, k: 'qty' }, { h: 'Unit', n: true, r: (r) => money(r.unit_cost) }, { h: 'Cost', n: true, r: (r) => money(r.part_cost) }, { h: '', r: (r) => r.is_general ? '<span class="pill p-idle">general</span>' : r.is_provisional ? '<span class="pill p-build">provisional</span>' : '' }], j.parts)));
  if ((j.outside || []).length || can('JOB.OUTSIDE'))
    v.append(card('Outside / subcontract repair', table([{ h: 'OSR No', k: 'osr_no' }, { h: 'Subcontractor', k: 'supplier_name' }, { h: 'Description', k: 'description' }, { h: 'Actual', n: true, r: (r) => money(r.actual_cost) }, { h: 'Status', r: (r) => statusPill(r.osr_status) }], j.outside || [])));
  v.append(card('Progress log', table([{ h: 'Date', k: 'progress_date' }, { h: 'Work done', k: 'work_done' }, { h: '%', n: true, r: (r) => int(r.pct_complete) }, { h: 'Hrs', n: true, r: (r) => int(r.hours_spent) }, { h: 'By', r: (r) => esc(r.logged_by || '—') }], j.progress || [])));
}
function progressForm(id) {
  formModal('Log daily progress', [
    { k: 'work_done', l: 'Work done' },
    { k: 'pct_complete', l: '% complete', type: 'number' }, { k: 'hours_spent', l: 'Hours spent', type: 'number' },
  ], async (d) => { await api(`/api/jobcards/${id}/progress`, { method: 'POST', body: JSON.stringify(d) }); toast('Progress logged'); openJob(id); });
}
function outsideForm(id) {
  formModal('Outside / subcontract repair', [
    { k: 'subcontractor_id', l: 'Subcontractor', sel: opt(M.suppliers || [], 'supplier_id', 'supplier_name') },
    { k: 'description', l: 'Description' }, { k: 'actual_cost', l: 'Actual cost (LKR)', type: 'number' },
    { k: 'osr_status', l: 'Status', sel: ['SENT', 'IN_PROGRESS', 'RECEIVED', 'INVOICED', 'CLOSED'].map((x) => `<option>${x}</option>`).join('') },
  ], async (d) => { await api(`/api/jobcards/${id}/outside-repair`, { method: 'POST', body: JSON.stringify(d) }); toast('Outside repair added'); openJob(id); });
}
function labourForm(id) {
  formModal('Add labour', [
    { k: 'employee_id', l: 'Technician', sel: opt(M.employees, 'employee_id', 'employee_name') },
    { k: 'hours', l: 'Hours', type: 'number' }, { k: 'ot_hours', l: 'OT hours', type: 'number' },
  ], async (d) => { await api(`/api/jobcards/${id}/labour`, { method: 'POST', body: JSON.stringify(d) }); toast('Labour added'); openJob(id); });
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
    toast('Issued'); jobId ? openJob(jobId) : route(mod);
  });
}
function pickAsset(title, cb) { formModal(title, [{ k: 'asset_id', l: 'Asset', sel: opt(M.assets, 'asset_id', 'asset_no') }], (d) => cb(d.asset_id)); }

/* ---------- tiny modal ---------- */
function formModal(title, fields, onSubmit, afterRender) {
  const body = fields.map((f) => `<label>${esc(f.l)}</label>` +
    (f.sel !== undefined ? `<select name="${f.k}">${f.sel}</select>` : `<input name="${f.k}" type="${f.type || 'text'}">`)).join('');
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
