// Ensures the sec_* + audit_log tables exist in inventory.db. Call once at startup (idempotent).
const { exec } = require('../db');

// Home site for existing single-site data. Legacy rows all belong to one physical
// store (E&C Workshop); they are backfilled to this id so today's users see no change.
const HOME_SITE_ID = Number(process.env.HOME_SITE_ID || 1);

// Row-bearing stores tables that carry per-site data and are site-scoped on read.
const SITE_TABLES = ['items', 'issues', 'material_transfers', 'general_items', 'batteries',
  'receipts', 'general_item_transactions', 'battery_movements'];

function ensure() {
  exec(`
    CREATE TABLE IF NOT EXISTS sec_user (
      id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      full_name TEXT, is_active INTEGER NOT NULL DEFAULT 1, is_locked INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0, last_login_at TEXT,
      mfa_secret TEXT, mfa_enabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS sec_role (id INTEGER PRIMARY KEY, role_code TEXT UNIQUE NOT NULL, role_name TEXT);
    CREATE TABLE IF NOT EXISTS sec_permission (id INTEGER PRIMARY KEY, permission_code TEXT UNIQUE NOT NULL, module TEXT, action TEXT);
    CREATE TABLE IF NOT EXISTS sec_user_role (user_id INTEGER NOT NULL, role_id INTEGER NOT NULL, PRIMARY KEY (user_id, role_id));
    CREATE TABLE IF NOT EXISTS sec_role_permission (role_id INTEGER NOT NULL, permission_id INTEGER NOT NULL, PRIMARY KEY (role_id, permission_id));
    CREATE TABLE IF NOT EXISTS sec_user_site (user_id INTEGER NOT NULL, location_id INTEGER NOT NULL, PRIMARY KEY (user_id, location_id));
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY, action TEXT NOT NULL,
      user_id INTEGER, entity TEXT, detail TEXT, at TEXT NOT NULL);
  `);
  // Existing inventory.db upgrades: add MFA columns if missing (CREATE IF NOT EXISTS won't).
  for (const alter of [
    "ALTER TABLE sec_user ADD COLUMN mfa_secret TEXT",
    "ALTER TABLE sec_user ADD COLUMN mfa_enabled INTEGER NOT NULL DEFAULT 0",
  ]) { try { exec(alter); } catch (_) { /* column already exists */ } }

  // Site column for row-level scoping. SQLite fills existing rows with the DEFAULT,
  // so legacy data lands on the home site automatically; a NULL guard covers any
  // table that already had the column added without one.
  for (const t of SITE_TABLES) {
    try { exec(`ALTER TABLE ${t} ADD COLUMN site_id INTEGER NOT NULL DEFAULT ${HOME_SITE_ID}`); }
    catch (_) { /* column already exists (or table absent) */ }
    try { exec(`UPDATE ${t} SET site_id = ${HOME_SITE_ID} WHERE site_id IS NULL`); } catch (_) {}
  }
}

module.exports = { ensure, HOME_SITE_ID, SITE_TABLES };
