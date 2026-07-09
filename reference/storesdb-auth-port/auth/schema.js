// Ensures the sec_* + audit_log tables exist in inventory.db. Call once at startup (idempotent).
const { exec } = require('../db');

function ensure() {
  exec(`
    CREATE TABLE IF NOT EXISTS sec_user (
      id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      full_name TEXT, is_active INTEGER NOT NULL DEFAULT 1, is_locked INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0, last_login_at TEXT,
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
}

module.exports = { ensure };
