# UMMS — Reference Auth + RBAC Module

A **runnable** reference implementation of the design in `docs/13-auth-rbac-design.md`. It replaces
the legacy stores app's hard‑coded `'E&CWorkshop'` password with real per‑user auth, role‑based
authorization, site‑scoped visibility, and an audit trail.

**Zero native builds required:** uses Node's built‑in `node:sqlite` and `crypto.scrypt` out of the
box; if `better-sqlite3` and/or `argon2` are installed it uses those automatically (argon2id is the
production default). Requires **Node ≥ 22.5**.

## Run it

```bash
cd reference/auth-module
npm install            # express, cookie-parser, express-rate-limit (pure JS)
npm run seed           # creates auth.db, roles/permissions, 4 sample users + stock
npm start              # serves http://127.0.0.1:4100
# in another shell:
npm test               # end-to-end smoke test (auth, RBAC, site scope, lockout)
```

Seeded logins: `admin/Admin@12345` (admin, all sites) · `pricing/Pricing@123` (can price) ·
`keeper_cmb/Keeper@cmb1` (CMB only) · `keeper_knd/Keeper@knd1` (KND only).

## What it demonstrates (the three enforcement points)
1. **Authentication** — `POST /auth/login` (rate‑limited, lockout after 5 fails) issues an
   httpOnly/SameSite session cookie; `authMiddleware` resolves it and loads the user's perms + sites.
2. **Authorization** — `requirePerm('STORES.PRICE')` / `requirePerm('STORES.DELETE')` gate the price
   and delete routes. A store keeper gets **403**; a pricing officer / admin gets **200**.
   `DELETE /api/items/:id` is the direct replacement for `verifyDeletePassword`.
3. **Site scoping** — `GET /api/stock` returns only the caller's site rows (`siteScope`); the KND
   keeper cannot see CMB stock; admins/managers with `READ.ALL_SITES` see everything.

Every login, authz‑deny, price change and delete is written to `audit_log`.

## Files
| File | Role |
|---|---|
| `auth/password.js` | argon2id → scrypt hashing |
| `auth/authMiddleware.js` | session → user + perms + sites |
| `auth/rbac.js` | `requirePerm()` + `siteScope()` |
| `auth/audit.js` | append‑only audit log |
| `routes/auth.js` | login / logout |
| `routes/demo.js` | site‑scoped read, price (perm), delete (perm) |
| `seed.js` | schema + roles/permissions + users |
| `server.js` | wiring; `/api/*` requires a session |
| `smoke-test.mjs` | proves the above end‑to‑end |

## Porting into the stores app
1. Add the `sec_*` + `audit_log` tables (already in `sql/schema.sql`); run `seed.js` logic to
   create real accounts (one per person) mapped to roles + sites.
2. `app.use('/auth', authRoutes)` then `app.use(authMiddleware)` before your API routes.
3. Wrap mutating routes with `requirePerm(...)`; **delete `verifyDeletePassword` and the
   `'E&CWorkshop'` constant**, replacing it with `requirePerm('STORES.DELETE')`.
4. Set `NODE_ENV=production` (Secure cookies) and terminate TLS at the proxy.
5. For production, `npm install argon2 better-sqlite3` (or point the data layer at PostgreSQL) — the
   code picks them up automatically.

> This is a **reference** to lift into the app, not a drop‑in server. Adapt the data layer to your
> production database (PostgreSQL per `sql/schema.sql`).
