# Master‑SAP / UMMS — Production Readiness Gate

> A tick‑box gate for moving from the current prototype/legacy state to a production deployment.
> **Do not go live until every 🔴 P0 item is checked.** Legend: 🔴 blocker · 🟠 at‑launch · 🟡 post‑launch.
> Owner column is indicative — assign a real name/date before sign‑off.
> Checkbox: `[x]` done & verified · `[~]` scripted/config provided, needs prod deploy · `[ ]` not started.

## Current state (what we are migrating from)
| System today | Reality found | Risk |
|---|---|---|
| Stores app (`storesdb`, Node + SQLite) | **No user auth** — only a hard‑coded delete password `'E&CWorkshop'` in `server.js`, accepted via URL query string | Critical — anyone on the network can read/write; secret is in source + logs |
| Oil app (`oilsystem`, React + Node + SQLite) | Has users/roles/sessions (better), but single‑file SQLite on a workstation | Concurrency, backup, no TLS |
| Excel workbooks (job records, daily work) | Manual, no validation, no audit | Data loss, no traceability |
| Backups | 30‑min file copies of the `.db` | Untested; not point‑in‑time; on same disk |
| Masters | Duplicated across apps + spreadsheets | Inconsistent item/asset/supplier data |

Target: **one UMMS instance, one server database, one set of masters** (see `docs/00`–`12`).

---

## 🔴 P0 — Go‑live blockers

### Security & access — `docs/07`, `docs/13`, `reference/storesdb-auth-port/`
- [x] **Remove the hard‑coded password** `'E&CWorkshop'` — **done & verified**: ported into the real app (`reference/storesdb-auth-port/`), old password now returns 401. *Rotate the value anywhere else it lived.*
- [x] Never accept credentials in query strings — login is a POST body; nothing sensitive in the URL.
- [x] Real per‑user authentication — argon2/scrypt hashing, server‑side sessions, httpOnly cookies, rate‑limit + lockout (booted & tested end‑to‑end).
- [x] **MFA (TOTP 2FA)** for `admin`/`finance` roles — **built & verified** in both `reference/auth-module/` and the real port (`reference/storesdb-auth-port/`): zero‑dependency RFC 6238 `auth/totp.js`, enrol/enable/disable at `/auth/mfa`, second‑factor step in login (MFA‑enabled account without a valid code → 401 `mfa:true`; valid code → 200). Smoke test **15/15**. *Enrol admin/finance at go‑live.*
- [x] **RBAC** — enforced on **delete AND write routes** (a single `/api` guard maps POST/PUT to `STORES.PRICE`/`STORES.ISSUE`/`STORES.TRANSFER`/`STORES.WRITE`; verified 401/403/200) + a login‑gated UI. *Review the route→perm map against every route.*
- [x] **Site‑scoped visibility** — **wired & proved across every read**: `site_id` on the stores tables (backfilled to the home site; child rows inherit the parent's site), `/api/*` reads require a session, and **all** reads — lists, single‑record `/:id` lookups, dropdowns, and dashboards/aggregates (`/api/dashboard/*`, `/api/sidebar-stats`, `/api/inventory`, `*/stats`) — filter by the user's `sec_user_site` (admin/`READ.ALL_SITES` see all). Verified end‑to‑end on the real `inventory.db` with a 2nd site: **20/20** core isolation + regression and **29/29** dashboard/aggregate sweep (site‑2 keeper: 10 items, 4 issues, ≤3 batteries, 2 transfers, 5 general SKUs; no read 500s). *(Also fixed a pre‑existing legacy bug where `/api/inventory` always 500'd on an escaped `${cte}` template.)*

### Transport & secrets
- [~] **HTTPS/TLS** everywhere via reverse proxy — **config provided** (`ops/proxy/nginx-umms.conf`: TLS1.2/1.3, HSTS, CSP, redirect); *deploy + install certs.* *(Owner: ___)*
- [ ] Secrets removed from source/committed `.env` → OS secret store / vault; rotate all creds that ever touched code (incl. `E&CWorkshop`). *(Owner: ___)*
- [~] CORS allow‑list, security headers, and request rate limiting — **in the nginx config + auth module**; wire app CORS allow‑list. *(Owner: ___)*
- [ ] Confirm all SQL is parameterized; keep `ORDER BY`/column names **allow‑listed** (already the pattern in `server.js` — do not regress). *(Owner: ___)*

### Data platform
- [x] Stand up **one server database (PostgreSQL)** from `sql/schema.sql` — **done & verified**: whole operation loaded (`migration/load_all_to_postgres.py`), 0 orphan FKs, cross‑module job cost queried in SQL.
- [x] DB‑level **FK / CHECK / UNIQUE** constraints enforced (schema loads under `ON_ERROR_STOP`); use atomic transactions (ledger row + balance in one txn) in the app.

### Data safety
- [~] **Automated, offsite, point‑in‑time backups** — **script provided** (`ops/backup/pg_backup.sh`: compressed dump + checksum + retention + encryption/offsite hooks; PITR notes in `ops/README.md`); *put on cron + set offsite target.* *(Owner: ___)*
- [x] **Tested restore** — **drill script PASSED** (`ops/backup/pg_restore_drill.sh`): restored latest dump into a clean DB, all key‑table counts + total stock value matched the live DB.

### Audit
- [ ] Every create/update/approve/reverse stamped **who + when + before/after**; reversals require a reason; no silent edits to price/cost. *(Owner: ___)*

### Migration cutover — `docs/08`, `migration/`, `ops/reconcile/`
- [~] Exception queues worked down — **worklists generated** by `ops/reconcile/reconcile.py` (pending pricing 1,510 · rate‑pending 114 lines/10 techs · negative on‑hand 5 · uncosted jobs · general‑asset jobs 4). *Work them down against final data.* *(Owner: ___)*
- [x] Opening balances loaded and **reconciled to control totals** — stock IN/OUT and Σ on‑hand match legacy exactly.
- [x] **Parallel‑run reconciliation** built & **run = GO** (`ops/reconcile/reconcile.py`): suppliers, stock IN, stock OUT, and net = on‑hand all MATCH legacy; re‑run on the real final load for sign‑off. *(Owner: ___)*
- [ ] Legacy systems frozen **read‑only** after cutover. *(Owner: ___)*

---

## 🟠 P1 — At / just after launch
- [ ] Run as a **managed service** (systemd / pm2 / container) with health checks — retire `run_hidden.vbs` / `start_server_silent.bat`.
- [ ] **Environments**: dev → staging → prod; versioned DB **migration tool** (no hand‑edited schema).
- [ ] **CI/CD** pipeline (build, test, deploy).
- [ ] **Monitoring & logging**: centralized logs, error tracking, uptime/metrics, alerting.
- [ ] **Automated tests** (unit + integration) + **UAT** with real storekeepers/managers.
- [ ] **Load test** for multi‑site concurrent use.
- [ ] **DR plan** with stated RTO/RPO; backup‑restore drill on a schedule.
- [ ] Configure **numbering series**, **approval workflows**, and **segregation of duties** (receiver ≠ pricer; issuer ≠ adjuster).
- [ ] Data‑privacy review for personal data (employees, users).

## 🟡 P2 — After you're live
- [ ] Barcode/QR scan‑to‑issue / scan battery serial — `docs/11`.
- [ ] Email / WhatsApp alert engine — `docs/11`.
- [ ] BI / Power‑BI reporting views — `docs/11`.
- [ ] Mobile shop‑floor screens (job progress, approvals) — `docs/09`.
- [ ] Stable, versioned public **API** — `docs/11`.
- [ ] Improve per‑job **material** costing via MRN→job linking (the gap in the job‑costing view).
- [ ] Optional SAP MM/PM/CO integration — `docs/11`.

---

## ✅ Minimum go‑live gate (summary)
Real user auth + RBAC · HTTPS + secrets out of code · server DB with **tested** backups · full audit trail · exception queues cleared + **one reconciled parallel run**. Everything else can follow.

## Risk register cross‑reference
See `docs/12-roadmap-appendices-risks.md` → Risk Register for likelihood/impact/mitigation of: dirty legacy data, unpriced receipts distorting costing, missed approvals, permission leakage across sites, backup/DR, and adoption.
