// UMMS unified platform — application server (PostgreSQL). First module: Workshop.
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { ensureSessionTable, authMiddleware } = require('./auth/mw');
const { ensureCounterTable } = require('./lib/numbering');
const { q } = require('./db');

const app = express();
app.disable('x-powered-by');
app.use(express.json());
app.use(cookieParser());

app.get('/health', (_req, res) => res.json({ ok: true, service: 'umms-app' }));
app.use('/auth', require('./routes/auth'));      // public
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
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.use('/api/jobcards', require('./routes/jobcards'));
app.use('/api/stores', require('./routes/stores'));
app.use('/api/oil', require('./routes/oil'));
app.use('/api/battery', require('./routes/battery'));

const PORT = process.env.PORT || 4000;
async function start() {
  await ensureSessionTable();
  await ensureCounterTable();
  return app.listen(PORT, () => console.log(`UMMS app on :${PORT} [db=${process.env.PGDATABASE}]`));
}

if (require.main === module) start().catch((e) => { console.error(e); process.exit(1); });
module.exports = { app, start };
