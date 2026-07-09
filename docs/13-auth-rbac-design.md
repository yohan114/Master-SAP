# UMMS — Authentication & RBAC Design (13)

> **Purpose:** replace the current stores‑app security (a hard‑coded password `'E&CWorkshop'` in
> `server.js`, accepted via URL query string, guarding only deletes) with real authentication,
> role‑based authorization, and site‑scoped data access. This is the **#1 production blocker**
> (`PRODUCTION_READINESS.md` → P0). Reference code is Node/Express to match the existing stack;
> the design is framework‑agnostic. Tables referenced (`sec_*`) already exist in `sql/schema.sql`.

---

## 1. What's wrong today (threat model)

| Issue | Where | Impact |
|---|---|---|
| Hard‑coded shared secret | `server.js` `verifyDeletePassword` → `'E&CWorkshop'` | Anyone with the source or a leaked value has full delete rights forever |
| Secret in query string | `req.query.password` | Logged in access logs, proxies, browser history |
| No authentication on reads/writes | most routes | Any host on the network can read/modify stock, prices, issues |
| No per‑user identity | — | No audit of *who* did what; no accountability |
| No authorization model | — | Cannot enforce "only pricing officer prices", "site users see own site" |

**Goal:** every request is *authenticated* (known user), *authorized* (role allows the action),
and *scoped* (site/project the user may see), with a full audit trail.

---

## 2. Target architecture

```
Browser ──HTTPS──> Reverse proxy (nginx/Caddy, TLS) ──> UMMS API (Express)
                                                          │  authMiddleware      → who are you?  (session/JWT)
                                                          │  rbacMiddleware(perm) → may you do this?
                                                          │  siteScope(query)     → what may you see?
                                                          └──> PostgreSQL (sec_* tables)
```

- **Auth:** username + password → server‑side **session token** (opaque, stored in `sessions`),
  delivered as an **httpOnly, Secure, SameSite=Lax cookie**. (JWT is an alternative; sessions are
  simpler to revoke and already modeled in `sql/schema.sql`.)
- **Password storage:** **argon2id** (preferred) or bcrypt(cost ≥ 12). Never plaintext, never MD5/SHA‑1.
- **Authorization:** role → permission mapping (`sec_role_permission`), checked per route by a
  `permission_code` (e.g. `STORES.PRICE`, `WORKSHOP.APPROVE`).
- **Scope:** `sec_user_site` limits row visibility to a user's sites unless the role is all‑site.

---

## 3. Data model (already in `sql/schema.sql`)

`sec_user` (username, password_hash, full_name, role via `sec_user_role`, is_locked, last_login_at),
`sec_role`, `sec_permission` (module, action → `permission_code`), `sec_role_permission`,
`sec_user_role`, `sec_user_site`, `sessions` (token, user_id, expires_at).

**Seed roles → key permissions (illustrative subset):**

| Role | Sample permissions |
|---|---|
| `store_keeper` | `STORES.CREATE`, `STORES.ISSUE`, `STORES.TRANSFER`, `STORES.READ` |
| `receiving_clerk` | `STORES.GRN.CREATE`, `STORES.READ` |
| `pricing_officer` | `STORES.PRICE`, `STORES.READ` (only role that may set prices) |
| `transport_manager` | `WORKSHOP.APPROVE.TM`, `READ.ALL_SITES` |
| `operational_manager` | `WORKSHOP.APPROVE.OM`, `READ.ALL_SITES` |
| `workshop_supervisor` | `WORKSHOP.EXECUTE`, `WORKSHOP.CLOSE` |
| `technician` | `WORKSHOP.LABOUR.CREATE`, `WORKSHOP.PROGRESS.CREATE` |
| `finance_reviewer` | `COSTING.READ`, `AUDIT.READ`, `STORES.READ` |
| `system_admin` | `ADMIN.*`, `MASTERS.WRITE`, `SECURITY.WRITE` |

Segregation of duties (enforced by not granting both to one role): receiver ≠ pricer; issuer ≠ adjuster; creator ≠ approver.

---

## 4. Reference implementation (Express)

### 4.1 Password hashing
```js
// auth/password.js
const argon2 = require('argon2');
const OPTS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
async function hashPassword(pw) { return argon2.hash(pw, OPTS); }
async function verifyPassword(hash, pw) { return argon2.verify(hash, pw); }
module.exports = { hashPassword, verifyPassword };
```

### 4.2 Login (rate‑limited, lockout, no secrets in URL)
```js
// routes/auth.js
const rateLimit = require('express-rate-limit');
const loginLimiter = rateLimit({ windowMs: 15*60*1000, max: 10 });   // 10 tries / 15 min / IP
const crypto = require('crypto');

router.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;                            // POST body, never query
  const user = db.get('SELECT * FROM sec_user WHERE username = ? AND is_active = 1', [username]);
  // constant-ish response regardless of which factor failed
  if (!user || user.is_locked || !(await verifyPassword(user.password_hash, password || ''))) {
    audit('LOGIN_FAIL', { username });
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 8*60*60*1000).toISOString();  // 8h
  db.run('INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)', [token, user.id, expires]);
  db.run('UPDATE sec_user SET last_login_at = ? WHERE id = ?', [new Date().toISOString(), user.id]);
  res.cookie('umms_sid', token, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 8*3600*1000 });
  audit('LOGIN_OK', { userId: user.id });
  res.json({ user: publicUser(user) });
});

router.post('/logout', (req, res) => {
  if (req.cookies.umms_sid) db.run('DELETE FROM sessions WHERE token = ?', [req.cookies.umms_sid]);
  res.clearCookie('umms_sid').json({ ok: true });
});
```

### 4.3 Auth middleware (who are you?)
```js
// auth/authMiddleware.js
function authMiddleware(req, res, next) {
  const token = req.cookies.umms_sid;
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });
  const s = db.get('SELECT * FROM sessions WHERE token = ? AND expires_at > ?',
                   [token, new Date().toISOString()]);
  if (!s) return res.status(401).json({ error: 'Session expired.' });
  const user = db.get('SELECT * FROM sec_user WHERE id = ? AND is_active = 1', [s.user_id]);
  if (!user || user.is_locked) return res.status(401).json({ error: 'Account unavailable.' });
  req.user = user;
  req.perms = new Set(db.all(`
    SELECT p.permission_code AS c FROM sec_user_role ur
    JOIN sec_role_permission rp ON rp.role_id = ur.role_id
    JOIN sec_permission p ON p.id = rp.permission_id
    WHERE ur.user_id = ?`, [user.id]).map(r => r.c));
  req.sites = new Set(db.all('SELECT location_id AS s FROM sec_user_site WHERE user_id = ?',
                             [user.id]).map(r => r.s));
  next();
}
```

### 4.4 RBAC middleware (may you do this?)
```js
// auth/rbac.js
const requirePerm = (code) => (req, res, next) => {
  if (req.perms.has(code) || req.perms.has('ADMIN.ALL')) return next();
  audit('AUTHZ_DENY', { userId: req.user.id, need: code, path: req.path });
  return res.status(403).json({ error: 'You do not have permission for this action.' });
};
// usage:
router.post('/grn/:id/price', authMiddleware, requirePerm('STORES.PRICE'), setPriceHandler);
router.post('/jobcards/:id/approve-om', authMiddleware, requirePerm('WORKSHOP.APPROVE.OM'), approveOm);
router.delete('/items/:id', authMiddleware, requirePerm('STORES.DELETE'), deleteItem);  // replaces the hard-coded password
```

### 4.5 Site scoping (what may you see?)
```js
// auth/siteScope.js — append a site filter unless the user is all-site
function siteScope(req, params) {
  if (req.perms.has('READ.ALL_SITES') || req.perms.has('ADMIN.ALL')) return { clause: '', params };
  const sites = [...req.sites];
  if (!sites.length) return { clause: ' AND 1=0', params };            // no site → see nothing
  return { clause: ` AND site_id IN (${sites.map(()=>'?').join(',')})`, params: [...params, ...sites] };
}
```

### 4.6 Audit helper (paired with every mutating route)
```js
function audit(action, meta) {
  db.run('INSERT INTO audit_log(action, user_id, entity, before_json, after_json, at) VALUES(?,?,?,?,?,?)',
    [action, meta.userId ?? null, meta.entity ?? null,
     JSON.stringify(meta.before ?? null), JSON.stringify(meta.after ?? null), new Date().toISOString()]);
}
```

---

## 5. Cookie / session hardening
- `httpOnly` (no JS access), `Secure` (HTTPS only), `SameSite=Lax`.
- **CSRF**: double‑submit token or `SameSite=Strict` for state‑changing routes; require a custom header (`X‑Requested‑With`) the browser only sends same‑origin.
- Session TTL 8h + idle timeout; rotate token on privilege change; `DELETE` sessions on logout and password change.
- Rate‑limit `/login`; lock account (`is_locked=1`) after N failures; admin unlock only.

## 6. Password & account policy
- Min length 10, block breached/common passwords, no reuse of last 5.
- First‑login forced change for seeded accounts; scheduled rotation for admin.
- **MFA (TOTP)** for `system_admin` and `finance_reviewer`.

## 7. Migration from the current stores app (cutover steps)
1. Add `sec_*` tables + `audit_log`; seed roles/permissions and a real `system_admin` (hashed).
2. Create per‑person accounts; map each to a role + sites (`sec_user_site`).
3. Wrap all routes: `app.use(authMiddleware)` globally, then `requirePerm(...)` per route.
4. **Delete** `verifyDeletePassword` and the `'E&CWorkshop'` constant; replace with `requirePerm('STORES.DELETE')`.
5. Force HTTPS (redirect 80→443) and set cookies `Secure`.
6. Smoke‑test each role against the permission matrix; verify a site user cannot read another site.
7. Turn on audit; confirm login/deny/mutation events are recorded.

## 8. Definition of done (maps to P0 gate)
- [ ] No secrets in source; `'E&CWorkshop'` removed and rotated.
- [ ] Every route behind `authMiddleware`; mutating routes behind `requirePerm`.
- [ ] Passwords argon2id; sessions httpOnly+Secure; login rate‑limited + lockout.
- [ ] Site scoping verified (a KND user cannot see CMB data).
- [ ] Audit log captures login, authz‑deny, and all price/cost/stock mutations.
