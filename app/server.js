// UMMS unified platform — application server (PostgreSQL). First module: Workshop.
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { ensureSessionTable, authMiddleware } = require('./auth/mw');
const { ensureCounterTable } = require('./lib/numbering');
const { q } = require('./db');

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1); // correct client IPs behind nginx
app.use(express.json());
app.use(cookieParser());

app.get('/health', (_req, res) => res.json({ ok: true, service: 'umms-app' }));
app.use('/auth', require('./routes/auth'));      // public (cookie-session login)
app.use('/api/v1', require('./routes/apiv1'));   // public REST API — Bearer-JWT auth, before the session gate
app.use(express.static(path.join(__dirname, 'public'))); // the unified web UI

app.use('/api', authMiddleware);                 // everything below requires a session
app.get('/api/me', (req, res) => res.json({ user: req.user, perms: [...req.perms], sites: [...req.sites] }));
app.get('/api/summary', async (req, res) => {
  try {
    const s = (await q(`SELECT
      (SELECT count(*) FROM md_item WHERE item_type<>'LUBRICANT' AND is_active) stores_items,
      (SELECT count(*) FROM md_item WHERE item_type='LUBRICANT' AND is_active) oil_products,
      (SELECT count(*) FROM md_asset WHERE is_active) assets,
      (SELECT count(*) FROM md_battery WHERE is_active) batteries,
      (SELECT count(*) FROM md_battery WHERE battery_status='IN_SERVICE') batteries_in_service,
      (SELECT count(*) FROM tx_jobcard WHERE is_active) jobs,
      (SELECT count(*) FROM tx_jobcard WHERE is_active AND jobcard_status NOT IN ('CLOSED','CANCELLED')) jobs_open,
      (SELECT count(*) FROM tx_mrn WHERE is_active AND doc_status NOT IN ('CLOSED','CANCELLED')) mrns_open,
      (SELECT count(*) FROM tx_po WHERE is_active AND doc_status NOT IN ('RECEIVED','CANCELLED','CLOSED')) pos_open,
      (SELECT count(*) FROM inv_pending_price WHERE is_active AND price_status<>'CONFIRMED') pending_pricing,
      (SELECT COALESCE(SUM(stock_value),0) FROM inv_stock_balance) stock_value,
      (SELECT COALESCE(SUM(total_job_cost),0) FROM cost_job_summary WHERE cost_status='FINALIZED') jobs_costed_value`))[0];
    res.json(s);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/masters', async (req, res) => {
  try {
    res.json({
      locations: await q("SELECT location_id, location_code, location_name FROM md_location WHERE is_active ORDER BY location_code"),
      assets: await q("SELECT asset_id, asset_no, asset_name, asset_class FROM md_asset WHERE is_active ORDER BY asset_no LIMIT 1000"),
      employees: await q("SELECT employee_id, employee_no, employee_name FROM md_employee WHERE is_active AND is_technician ORDER BY employee_no"),
      uoms: await q("SELECT uom_id, uom_code, uom_name FROM md_uom WHERE is_active ORDER BY uom_code"),
      categories: await q("SELECT category_id, category_code, category_name FROM md_item_category WHERE is_active ORDER BY category_name"),
      suppliers: await q("SELECT supplier_id, supplier_no, supplier_name FROM md_supplier WHERE is_active ORDER BY supplier_name"),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.use('/api/jobcards', require('./routes/jobcards'));
app.use('/api/stores', require('./routes/stores'));
app.use('/api/transfers', require('./routes/transfers'));
app.use('/api/purchase', require('./routes/purchase'));
app.use('/api/oil', require('./routes/oil'));
app.use('/api/battery', require('./routes/battery'));
app.use('/api/mrn', require('./routes/mrn'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/alerts', require('./routes/alerts'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/auth', require('./routes/account').router);   // authenticated self-service (change-password)
app.use('/api/admin', require('./routes/admin'));

const PORT = process.env.PORT || 4000;
async function start() {
  await ensureSessionTable();
  await ensureCounterTable();
  return app.listen(PORT, () => console.log(`UMMS app on :${PORT} [db=${process.env.PGDATABASE}]`));
}

if (require.main === module) start().catch((e) => { console.error(e); process.exit(1); });
module.exports = { app, start };
