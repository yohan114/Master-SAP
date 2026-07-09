// Wires the auth module together. Everything under /api requires a valid session.
const express = require('express');
const cookieParser = require('cookie-parser');
const { authMiddleware } = require('./auth/authMiddleware');
const { kind } = require('./db');
const { usingArgon2 } = require('./auth/password');

const app = express();
app.disable('x-powered-by');
app.use(express.json());
app.use(cookieParser());

// --- public ---
app.use('/auth', require('./routes/auth')); // /auth/login, /auth/logout
app.get('/health', (_req, res) => res.json({ ok: true }));

// --- everything below requires authentication ---
app.use(authMiddleware);
app.get('/auth/me', (req, res) =>
  res.json({ user: { id: req.user.id, username: req.user.username }, perms: [...req.perms], sites: [...req.sites] })
);
app.use('/api', require('./routes/demo'));

const PORT = process.env.PORT || 4100;
if (require.main === module) {
  app.listen(PORT, () => console.log(`UMMS auth module on :${PORT}  [db=${kind}, hash=${usingArgon2 ? 'argon2id' : 'scrypt'}]`));
}
module.exports = app;
