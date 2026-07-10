// UMMS unified platform — application server (PostgreSQL). First module: Workshop.
const express = require('express');
const cookieParser = require('cookie-parser');
const { ensureSessionTable, authMiddleware } = require('./auth/mw');
const { ensureCounterTable } = require('./lib/numbering');

const app = express();
app.disable('x-powered-by');
app.use(express.json());
app.use(cookieParser());

app.get('/health', (_req, res) => res.json({ ok: true, service: 'umms-app' }));
app.use('/auth', require('./routes/auth'));      // public

app.use('/api', authMiddleware);                 // everything below requires a session
app.get('/api/me', (req, res) => res.json({ user: req.user, perms: [...req.perms], sites: [...req.sites] }));
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
