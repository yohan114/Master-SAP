# storesdb — auth port (removes the hard‑coded password)

Drop‑in files + a patch that replace the legacy stores app's hard‑coded delete password
(`'E&CWorkshop'` in `server.js`, accepted via URL query) with **real per‑user authentication,
RBAC, and an audit trail**. Implements `docs/13-auth-rbac-design.md` inside the actual app.

## Verified (booted the real ported `server.js` on `node:sqlite`)

**Auth + delete routes**

| Check | Result |
|---|---|
| Old hard‑coded password header, no session → DELETE | **401** (no longer works) |
| DELETE with no auth · login admin/keeper · wrong password | **401 · 200 · 401** |
| Store keeper DELETE (no `STORES.DELETE`) → admin DELETE | **403 → 200** |

**Write routes (single `/api` mutation guard, GET reads open, DELETE per‑route)**

| Check | Result |
|---|---|
| Unauth `PUT /api/items/1` | **401** |
| Store keeper `PUT /api/items/1` (`STORES.WRITE`) · `POST /api/transfers` (`STORES.TRANSFER`) | **allowed** |
| Store keeper `PUT /api/receipts/1` (pricing, no `STORES.PRICE`) | **403** |
| Pricing officer `PUT /api/receipts/1` (`STORES.PRICE`) → `PUT /api/items/1` (no write) | **200 → 403** |

**Login page + UI gate**

| Check | Result |
|---|---|
| `GET /` and `/item_tracker.html` unauthenticated | **302 → `/login.html`** |
| `GET /item_tracker.html` with valid session | **200** |
| `audit_log` records LOGIN_OK / LOGIN_FAIL / AUTHZ_DENY | ✅ |

**MFA / 2FA (TOTP, RFC 6238 — for admin/finance)**

| Check | Result |
|---|---|
| MFA‑enabled `admin` login with **no** authenticator code | **401** (`mfa: true`) |
| MFA‑enabled `admin` login with a **wrong** code | **401** |
| MFA‑enabled `admin` login with a **valid** TOTP code | **200** |
| Non‑MFA `keeper` login (unaffected) | **200** |

## Files
| File | Purpose |
|---|---|
| `auth/password.js` | argon2id → scrypt hashing (no native build needed) |
| `auth/authMiddleware.js` | session cookie → user + permissions |
| `auth/rbac.js` | `requirePerm()` + `siteScope()` |
| `auth/audit.js` | append‑only `audit_log` writes |
| `auth/schema.js` | `ensure()` creates the `sec_*` + `audit_log` tables in `inventory.db` |
| `auth/routes.js` | `POST /auth/login` (rate‑limited + lockout + **MFA second‑factor step**) · `POST /auth/logout` |
| `auth/totp.js` | zero‑dependency RFC 6238 TOTP (base32, HMAC‑SHA1, `verifyTotp` with ±1 step window) |
| `seed-users.js` | roles/permissions + first admin/keeper/pricing users |
| `login.html` | minimal styled login page (posts to `/auth/login`, redirects to the tracker) |
| `server.js.patch` | the exact edits: auth wiring, `/api` write guard, delete‑route gating, login gate |

## Apply it
```bash
cd storesdb
cp -r /path/to/reference/storesdb-auth-port/auth .        # drop in auth/
cp    /path/to/reference/storesdb-auth-port/seed-users.js /path/to/reference/storesdb-auth-port/login.html .
git apply /path/to/reference/storesdb-auth-port/server.js.patch   # or apply the edits by hand
npm install cookie-parser express-rate-limit               # (+ argon2 for prod-grade hashing)
node seed-users.js                                         # creates sec_* tables + users
# restart the app
```

The patch: adds `cookie-parser` + auth wiring after `express.json`; mounts `/auth`; **deletes
`verifyDeletePassword` and the `'E&CWorkshop'` constant** and gates all 6 delete routes with
`requirePerm('STORES.DELETE')`; adds a single **`/api` write guard** (POST/PUT/PATCH → auth +
`STORES.PRICE` / `STORES.ISSUE` / `STORES.TRANSFER` / `STORES.WRITE` by route, GET reads left open);
and gates the tracker UI behind login (unauthenticated → `/login.html`).

## Before go‑live
- **Change the seeded passwords** immediately (they're placeholders) and force first‑login change.
- Set `NODE_ENV=production` so session cookies are `Secure`; terminate TLS at the proxy
  (`ops/proxy/nginx-umms.conf`) and `app.set('trust proxy', 1)`.
- Review the route→permission mapping in `permForMutation()` against your exact routes. Site‑scoping
  (`siteScope`) is ready to wire once the stores tables carry a `site_id`.
- **MFA is built in** (`auth/totp.js`; `login` enforces the second factor when `mfa_enabled=1`).
  `schema.js` adds the `mfa_secret`/`mfa_enabled` columns automatically. Enrol admin/finance at
  go‑live: set a secret, have them scan the `otpauth://` URI, then flip `mfa_enabled=1`.
- For prod‑grade hashing run `npm install argon2` (the code auto‑detects and uses it).
