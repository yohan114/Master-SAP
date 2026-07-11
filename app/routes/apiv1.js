// Public, versioned REST API (/api/v1) for external systems — SAP Fiori / Integration Suite, HTTP
// adapters, BI. Auth is a service-account client-credentials flow: POST /auth/token exchanges a
// client_id/secret (from sec_service_account) for an 8-hour Bearer JWT; the read endpoints require it.
// GET /openapi.json publishes an OpenAPI 3.0 document so the surface is auto-discoverable.
//
// This router is mounted BEFORE the session authMiddleware, so /api/v1 never touches the cookie-session
// auth — it is Bearer-only. Every query is parameterized and engine-agnostic (works on PostgreSQL and
// SQLite): optional filters use a "$n IS NULL OR …"-free builder, and case-insensitive search uses
// LOWER(col) LIKE rather than ILIKE.
const express = require('express');
const { q, one } = require('../db');
const { verifyPassword } = require('../auth/password');
const jwt = require('../auth/jwt');

const router = express.Router();
const TOKEN_TTL = 8 * 3600;   // 8 hours
const SECRET = process.env.API_JWT_SECRET || 'umms-dev-insecure-jwt-secret-change-me';
if (!process.env.API_JWT_SECRET) console.warn('[api/v1] API_JWT_SECRET not set — using an insecure dev default. Set it in production.');

// Tiny ordered param builder: b.p(value) records a param and returns its placeholder ($1, $2, …) in
// the exact order it appears in the SQL string. A placeholder may be reused (both engines bind by index).
function qb() { const params = []; return { p(v) { params.push(v); return `$${params.length}`; }, get params() { return params; } }; }
const num = (v) => (v == null ? 0 : Number(v));

// ---- auth: client-credentials -> JWT -------------------------------------
router.post('/auth/token', async (req, res) => {
  try {
    const { client_id, client_secret } = req.body || {};
    const acct = await one('SELECT service_account_id, client_id, client_secret_hash, scopes FROM sec_service_account WHERE client_id=$1 AND is_active', [client_id]);
    if (!acct || !verifyPassword(acct.client_secret_hash, client_secret || '')) return res.status(401).json({ error: 'invalid_client' });
    await q('UPDATE sec_service_account SET last_token_at=now() WHERE service_account_id=$1', [acct.service_account_id]);
    const iat = Math.floor(Date.now() / 1000);
    const token = jwt.sign({ iss: 'umms', sub: acct.client_id, sa: acct.service_account_id, scope: acct.scopes || 'read', iat, exp: iat + TOKEN_TTL }, SECRET);
    res.json({ access_token: token, token_type: 'Bearer', expires_in: TOKEN_TTL, scope: acct.scopes || 'read' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- bearer guard for the data endpoints ---------------------------------
function bearer(req, res, next) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!m) return res.status(401).json({ error: 'missing_bearer_token' });
  try { req.svc = jwt.verify(m[1], SECRET); next(); }
  catch (e) { res.status(401).json({ error: 'invalid_token', detail: e.message }); }
}

// Restrict a stock subquery to a site's locations (site_code or location_code), or no restriction.
function siteClause(b, alias, site) {
  return site ? `AND ${alias}.location_id IN (SELECT location_id FROM md_location WHERE site_code=${b.p(site)} OR location_code=${b.p(site)})` : '';
}
const likeParam = (s) => `%${String(s).toLowerCase()}%`;

// ---- GET /items — item master + current stock -----------------------------
router.get('/items', bearer, async (req, res) => {
  try {
    const { site, category, search } = req.query;
    const b = qb();
    const sc = siteClause(b, 'sb', site);   // pushes site params first (they appear in the SELECT)
    const stock = (col) => `COALESCE((SELECT SUM(sb.${col}) FROM inv_stock_balance sb WHERE sb.item_id=i.item_id ${sc}),0)`;
    const where = ['i.is_active'];
    if (category) where.push(`c.category_code=${b.p(category)}`);
    if (search) { const lp = b.p(likeParam(search)); where.push(`(LOWER(i.item_no) LIKE ${lp} OR LOWER(i.item_name) LIKE ${lp})`); }
    const rows = await q(
      `SELECT i.item_no AS item_code, i.item_name, i.item_type, c.category_code, c.category_name, u.uom_code,
              ${stock('on_hand_qty')} AS qty_on_hand, ${stock('stock_value')} AS stock_value
       FROM md_item i
       LEFT JOIN md_item_category c ON c.category_id=i.category_id
       LEFT JOIN md_uom u ON u.uom_id=i.base_uom_id
       WHERE ${where.join(' AND ')}
       ORDER BY i.item_no LIMIT 500`, b.params);
    const items = rows.map((r) => { const qty = num(r.qty_on_hand), val = num(r.stock_value); return {
      item_code: r.item_code, item_name: r.item_name, item_type: r.item_type,
      category_code: r.category_code, category_name: r.category_name, uom: r.uom_code,
      qty_on_hand: qty, stock_value: Math.round(val * 100) / 100, unit_cost: qty > 0 ? Math.round((val / qty) * 10000) / 10000 : 0 }; });
    res.json({ count: items.length, items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- GET /stock-balance — on-hand + unit cost per item/location -----------
router.get('/stock-balance', bearer, async (req, res) => {
  try {
    const { site, item_code } = req.query;
    const b = qb();
    const where = ['b.is_active'];
    if (item_code) where.push(`i.item_no=${b.p(item_code)}`);
    if (site) where.push(`(l.site_code=${b.p(site)} OR l.location_code=${b.p(site)})`);
    const rows = await q(
      `SELECT i.item_no AS item_code, i.item_name, l.location_code, l.location_name, l.site_code,
              b.on_hand_qty AS qty_on_hand, b.reserved_qty, b.available_qty, b.moving_avg_cost AS unit_cost, b.stock_value
       FROM inv_stock_balance b JOIN md_item i ON i.item_id=b.item_id JOIN md_location l ON l.location_id=b.location_id
       WHERE ${where.join(' AND ')} ORDER BY i.item_no, l.location_code LIMIT 1000`, b.params);
    res.json({ count: rows.length, balances: rows.map((r) => ({
      item_code: r.item_code, item_name: r.item_name, location_code: r.location_code, location_name: r.location_name,
      site_code: r.site_code, qty_on_hand: num(r.qty_on_hand), reserved_qty: num(r.reserved_qty),
      available_qty: num(r.available_qty), unit_cost: num(r.unit_cost), stock_value: num(r.stock_value) })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- GET /jobcards — job cards + cost summary -----------------------------
router.get('/jobcards', bearer, async (req, res) => {
  try {
    const { status, asset, from, to } = req.query;
    const b = qb();
    const where = ['jc.is_active'];
    if (status) where.push(`jc.jobcard_status=${b.p(status)}`);
    if (asset) where.push(`a.asset_no=${b.p(asset)}`);
    if (from) where.push(`jc.jobcard_date >= ${b.p(from)}`);
    if (to) where.push(`jc.jobcard_date <= ${b.p(to)}`);
    const rows = await q(
      `SELECT jc.jobcard_no, jc.jobcard_date, jc.job_type, jc.jobcard_status, a.asset_no, a.asset_name,
              jc.estimated_cost, jc.total_job_cost,
              cs.material_cost, cs.labour_cost, cs.outside_repair_cost, cs.general_cost,
              cs.variance_amt, cs.cost_status
       FROM tx_jobcard jc JOIN md_asset a ON a.asset_id=jc.asset_id
       LEFT JOIN cost_job_summary cs ON cs.jobcard_id=jc.jobcard_id
       WHERE ${where.join(' AND ')} ORDER BY jc.jobcard_id DESC LIMIT 500`, b.params);
    res.json({ count: rows.length, jobcards: rows.map((r) => ({
      jobcard_no: r.jobcard_no, jobcard_date: r.jobcard_date, job_type: r.job_type, status: r.jobcard_status,
      asset_no: r.asset_no, asset_name: r.asset_name, estimated_cost: num(r.estimated_cost), total_job_cost: num(r.total_job_cost),
      cost_summary: r.cost_status ? {
        material_cost: num(r.material_cost), labour_cost: num(r.labour_cost), outside_repair_cost: num(r.outside_repair_cost),
        general_cost: num(r.general_cost), variance_amt: num(r.variance_amt), cost_status: r.cost_status } : null })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- GET /grns — goods-receipt notes + line items -------------------------
router.get('/grns', bearer, async (req, res) => {
  try {
    const { from, to, supplier } = req.query;
    const b = qb();
    const where = ['g.is_active'];
    if (from) where.push(`g.grn_date >= ${b.p(from)}`);
    if (to) where.push(`g.grn_date <= ${b.p(to)}`);
    if (supplier) { const sp = b.p(supplier); const lp = b.p(likeParam(supplier)); where.push(`(s.supplier_no=${sp} OR LOWER(s.supplier_name) LIKE ${lp})`); }
    const heads = await q(
      `SELECT g.grn_id, g.grn_no, g.grn_date, s.supplier_no, s.supplier_name, l.location_code AS received_at,
              g.supplier_invoice_no, g.total_qty, g.total_amt, g.doc_status
       FROM tx_grn g JOIN md_supplier s ON s.supplier_id=g.supplier_id JOIN md_location l ON l.location_id=g.location_id
       WHERE ${where.join(' AND ')} ORDER BY g.grn_id DESC LIMIT 500`, b.params);
    const byId = new Map(heads.map((h) => [h.grn_id, {
      grn_no: h.grn_no, grn_date: h.grn_date, supplier_no: h.supplier_no, supplier_name: h.supplier_name,
      received_at: h.received_at, supplier_invoice_no: h.supplier_invoice_no,
      total_qty: num(h.total_qty), total_amt: num(h.total_amt), status: h.doc_status, lines: [] }]));
    if (heads.length) {
      const lb = qb();
      const ids = heads.map((h) => lb.p(h.grn_id)).join(',');
      const lines = await q(
        `SELECT x.grn_id, x.line_no, i.item_no AS item_code, i.item_name, u.uom_code,
                x.received_qty, x.accepted_qty, x.unit_price, x.line_amt, x.price_status
         FROM txl_grn x JOIN md_item i ON i.item_id=x.item_id JOIN md_uom u ON u.uom_id=x.uom_id
         WHERE x.grn_id IN (${ids}) ORDER BY x.grn_id, x.line_no`, lb.params);
      for (const ln of lines) byId.get(ln.grn_id)?.lines.push({
        line_no: ln.line_no, item_code: ln.item_code, item_name: ln.item_name, uom: ln.uom_code,
        received_qty: num(ln.received_qty), accepted_qty: num(ln.accepted_qty),
        unit_price: num(ln.unit_price), line_amt: num(ln.line_amt), price_status: ln.price_status });
    }
    const grns = [...byId.values()];
    res.json({ count: grns.length, grns });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- GET /assets — fleet master + currently-installed battery -------------
router.get('/assets', bearer, async (req, res) => {
  try {
    const rows = await q(
      `SELECT a.asset_no, a.asset_name, a.asset_class, a.asset_status, l.location_code AS site, l.site_code,
              bt.battery_serial_no AS current_battery_serial, bi.item_name AS current_battery_model, bt.battery_status
       FROM md_asset a
       LEFT JOIN md_location l ON l.location_id=a.site_id
       LEFT JOIN md_battery bt ON bt.current_asset_id=a.asset_id AND bt.is_active AND bt.battery_status='IN_SERVICE'
       LEFT JOIN md_item bi ON bi.item_id=bt.item_id
       WHERE a.is_active ORDER BY a.asset_no LIMIT 1000`);
    res.json({ count: rows.length, assets: rows.map((r) => ({
      asset_no: r.asset_no, asset_name: r.asset_name, asset_class: r.asset_class, asset_status: r.asset_status,
      site: r.site, site_code: r.site_code,
      current_battery: r.current_battery_serial ? { serial_no: r.current_battery_serial, model: r.current_battery_model, status: r.battery_status } : null })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- GET /openapi.json — OpenAPI 3.0 discovery document --------------------
router.get('/openapi.json', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}/api/v1`;
  const secured = [{ bearerAuth: [] }];
  const listResp = (name) => ({ '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { count: { type: 'integer' }, [name]: { type: 'array', items: { type: 'object' } } } } } } }, '401': { description: 'Unauthorized' } });
  const param = (n, d) => ({ name: n, in: 'query', required: false, schema: { type: 'string' }, description: d });
  res.json({
    openapi: '3.0.3',
    info: { title: 'UMMS REST API', version: 'v1', description: 'Read API over the Unified Master Management System for SAP Fiori / Integration Suite and other external consumers.' },
    servers: [{ url: base }],
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      schemas: {
        TokenRequest: { type: 'object', required: ['client_id', 'client_secret'], properties: { client_id: { type: 'string' }, client_secret: { type: 'string' } } },
        TokenResponse: { type: 'object', properties: { access_token: { type: 'string' }, token_type: { type: 'string' }, expires_in: { type: 'integer' }, scope: { type: 'string' } } },
      },
    },
    paths: {
      '/auth/token': { post: { summary: 'Exchange service-account credentials for a Bearer JWT (8h)', requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/TokenRequest' } } } }, responses: { '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/TokenResponse' } } } }, '401': { description: 'invalid_client' } } } },
      '/items': { get: { summary: 'Item master with current stock', security: secured, parameters: [param('site', 'site_code or location_code'), param('category', 'category_code'), param('search', 'match item code or name')], responses: listResp('items') } },
      '/stock-balance': { get: { summary: 'On-hand qty and unit cost per item/location', security: secured, parameters: [param('site', 'site_code or location_code'), param('item_code', 'item number')], responses: listResp('balances') } },
      '/jobcards': { get: { summary: 'Job cards with cost summary', security: secured, parameters: [param('status', 'jobcard status'), param('asset', 'asset number'), param('from', 'date from (YYYY-MM-DD)'), param('to', 'date to (YYYY-MM-DD)')], responses: listResp('jobcards') } },
      '/grns': { get: { summary: 'Goods-receipt notes with line items', security: secured, parameters: [param('from', 'date from'), param('to', 'date to'), param('supplier', 'supplier number or name')], responses: listResp('grns') } },
      '/assets': { get: { summary: 'Fleet/machine master with current battery', security: secured, responses: listResp('assets') } },
      '/openapi.json': { get: { summary: 'This OpenAPI document', responses: { '200': { description: 'OK' } } } },
    },
  });
});

module.exports = router;
