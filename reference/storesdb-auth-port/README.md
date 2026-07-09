# storesdb — auth port (removes the hard‑coded password)

Drop‑in files + a patch that replace the legacy stores app's hard‑coded delete password
(`'E&CWorkshop'` in `server.js`, accepted via URL query) with **real per‑user authentication,
RBAC, and an audit trail**. Implements `docs/13-auth-rbac-design.md` inside the actual app.

## Verified (booted the real ported `server.js` on `node:sqlite`)

| Check | Result |
|---|---|
| Old hard‑coded password header, no session → DELETE | **401** (no longer works) |
| DELETE with no auth | **401** |
| Login admin / keeper | **200** |
| Login wrong password | **401** |
| Store keeper DELETE (no `STORES.DELETE`) | **403** |
| Admin DELETE (has `STORES.DELETE`) | **200** |
| `audit_log` records LOGIN_OK / LOGIN_FAIL / AUTHZ_DENY | ✅ |

## Files
| File | Purpose |
|---|---|
| `auth/password.js` | argon2id → scrypt hashing (no native build needed) |
| `auth/authMiddleware.js` | session cookie → user + permissions |
| `auth/rbac.js` | `requirePerm()` + `siteScope()` |
| `auth/audit.js` | append‑only `audit_log` writes |
| `auth/schema.js` | `ensure()` creates the `sec_*` + `audit_log` tables in `inventory.db` |
| `auth/routes.js` | `POST /auth/login` (rate‑limited + lockout) · `POST /auth/logout` |
| `seed-users.js` | roles/permissions + first admin/keeper/pricing users |
| `server.js.patch` | the exact 4‑part edit to `server.js` |

## Apply it
```bash
cd storesdb
cp -r /path/to/reference/storesdb-auth-port/auth .        # drop in auth/
cp    /path/to/reference/storesdb-auth-port/seed-users.js .
git apply /path/to/reference/storesdb-auth-port/server.js.patch   # or apply the 4 edits by hand
npm install cookie-parser express-rate-limit               # (+ argon2 for prod-grade hashing)
node seed-users.js                                         # creates sec_* tables + users
# restart the app
```

The patch does four things: adds `cookie-parser` + the auth wiring after `express.json`, mounts
`/auth`, **deletes `verifyDeletePassword` and the `'E&CWorkshop'` constant**, and swaps every
`app.delete(..., verifyDeletePassword, ...)` for `app.delete(..., ...requireAuthPerm('STORES.DELETE'), ...)`.

## Before go‑live
- **Change the seeded passwords** immediately (they're placeholders) and force first‑login change.
- Set `NODE_ENV=production` so session cookies are `Secure`; terminate TLS at the proxy
  (`ops/proxy/nginx-umms.conf`) and `app.set('trust proxy', 1)`.
- Extend the same `authMiddleware` + `requirePerm(...)` pattern to the **POST/PUT** routes
  (e.g. `STORES.PRICE` on the GRN pricing route, `STORES.CREATE` on inserts) — deletes are done
  here because they were the only thing the legacy password guarded.
- For prod‑grade hashing run `npm install argon2` (the code auto‑detects and uses it).
