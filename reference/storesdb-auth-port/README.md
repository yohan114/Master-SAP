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

**Site‑scoped visibility** — proved end‑to‑end on the real `inventory.db` (4000 items, 299 issues,
37 batteries, 93 transfers, 78 general items) with 10/4/3/2/5 rows moved to a second site. **Every
read is scoped** — list views, single‑record `/:id` lookups, dropdowns, and the dashboard/aggregate
endpoints:

| Check | Result |
|---|---|
| Unauthenticated `GET /api/*` reads (reads now require a session) | **401** |
| `admin` (all sites) sees **totals** — items 4000 · issues 299 · batteries 37 · transfers 93 · general 78 | ✅ |
| site‑1 `keeper` sees **only site 1** — 3990 · 295 · 34 · 91 · 73 | ✅ |
| site‑2 keeper sees **only site 2** — 10 · 4 · 3 · 2 · 5 | ✅ |
| Both paginated (`total`) and unpaginated (array) list paths scoped | ✅ |
| **Dashboards/aggregates** scoped — `sidebar-stats` totalItems 10 · totalIssues 4, `battery-stats` ≤3, `transfer-stats` 2, `general-items/stats` 5, `all-vehicles` 10 (vs 812) for the site‑2 keeper | ✅ |
| Single‑record `/api/{batteries,transfers,general-items}/:id` return **404** across sites | ✅ |
| No `/api/*` read returns a 500; delete‑gating, write‑RBAC and the login gate still hold | ✅ |

*(All assertions pass — 20/20 core isolation + regression, 29/29 dashboard/aggregate sweep.)*

> While wiring the scope I also fixed a **pre‑existing legacy bug**: `/api/inventory` had an escaped
> template (`\${cte}`/`\${whereSql}`/`\${sortCol}`) that emitted literal `${cte}` into the SQL, so the
> stock view always 500'd (`unrecognized token "$"`). Unescaping it makes the endpoint work — and it's
> now site‑scoped like the rest.

**Audit trail (who + when + before/after)** — one `auditChange` middleware records every `/api`
mutation into `audit_log`, snapshotting the affected row before and after the handler runs:

| Action | Recorded |
|---|---|
| `POST /api/items` (create) | actor, new row id, **after**‑image |
| `PUT /api/items/:id` (edit) | actor, **before/after**, `changed: [itemName, reqQty]` |
| `PUT /api/receipts/:id` (pricing) | actor, `changed: [unitPrice]`, **unitPrice None→1234**, `reason` |
| `DELETE /api/items/:id` (admin) | actor, **before**‑snapshot, `reason` |
| `DELETE /api/items/:id` (keeper, no perm) | actor, **status 403 `[denied]`**, before‑snapshot |

Credentials/tokens are redacted from the logged request body; a `reason` field (for
reversals/adjustments) is captured whenever the caller supplies one.

## Files
| File | Purpose |
|---|---|
| `auth/password.js` | argon2id → scrypt hashing (no native build needed) |
| `auth/authMiddleware.js` | session cookie → user + permissions |
| `auth/rbac.js` | `requirePerm()` + `siteScope()` + **`scopeWhere(req, alias)`** (row‑level site filter as a bare `WHERE` condition) |
| `auth/audit.js` | append‑only `audit_log` writes |
| `auth/auditChange.js` | mutation audit middleware — snapshots the affected row **before/after** every create/update/delete and logs who + when + changed fields |
| `auth/schema.js` | `ensure()` creates the `sec_*` + `audit_log` tables **and adds a `site_id` column (backfilled to the home site) to the row‑bearing stores tables** |
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
`requirePerm('STORES.DELETE')`; adds a single **`/api` guard** where **every read requires a valid
session** (so results can be site‑scoped and nothing leaks to anonymous callers) and mutations
additionally need `STORES.PRICE` / `STORES.ISSUE` / `STORES.TRANSFER` / `STORES.WRITE` by route;
splices **`scopeWhere(req)` into every read** (lists, `/:id` lookups, dropdowns, dashboards/aggregates)
so a keeper only sees their assigned site(s); mounts the **`auditChange` middleware** so every mutation
is recorded with who/when/before/after; and gates the tracker UI behind login (unauthenticated →
`/login.html`).

## Before go‑live
- **Change the seeded passwords** immediately (they're placeholders) and force first‑login change.
- Set `NODE_ENV=production` so session cookies are `Secure`; terminate TLS at the proxy
  (`ops/proxy/nginx-umms.conf`) and `app.set('trust proxy', 1)`.
- Review the route→permission mapping in `permForMutation()` against your exact routes.
- **Site‑scoping is wired across every read**: `schema.js` adds `site_id` to the stores tables
  (existing rows → `HOME_SITE_ID`, default 1; child rows inherit their parent's site), and all reads —
  lists, single‑record `/:id` lookups, dropdowns, and the dashboard/aggregate endpoints
  (`/api/dashboard/*`, `/api/sidebar-stats`, `/api/inventory`, `*/stats`) — filter by the user's
  `sec_user_site` assignment (admins / `READ.ALL_SITES` see everything). Give each real site an id,
  assign keepers with `INSERT INTO sec_user_site(user_id, location_id)`, and set `site_id` on new rows
  as you create them (the write routes should stamp the creator's site — a natural follow‑on).
- **MFA is built in** (`auth/totp.js`; `login` enforces the second factor when `mfa_enabled=1`).
  `schema.js` adds the `mfa_secret`/`mfa_enabled` columns automatically. Enrol admin/finance at
  go‑live: set a secret, have them scan the `otpauth://` URI, then flip `mfa_enabled=1`.
- For prod‑grade hashing run `npm install argon2` (the code auto‑detects and uses it).
