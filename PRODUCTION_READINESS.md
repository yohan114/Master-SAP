# Master‑SAP / UMMS — Production Readiness Gate

> A tick‑box gate for moving from the current prototype/legacy state to a production deployment.
> **Do not go live until every 🔴 P0 item is checked.** Legend: 🔴 blocker · 🟠 at‑launch · 🟡 post‑launch.
> Owner column is indicative — assign a real name/date before sign‑off.

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

### Security & access — `docs/07`, `docs/13`
- [ ] **Remove the hard‑coded password** `'E&CWorkshop'` from `server.js` and rotate it. *(Owner: ___)*
- [ ] Never accept credentials/passwords in query strings or logs. *(Owner: ___)*
- [ ] Real per‑user authentication: unique accounts, **argon2/bcrypt** hashing, server‑side sessions or short‑lived JWT, account lockout, password policy. *(Owner: ___)*
- [ ] **MFA** for `admin` and `finance` roles. *(Owner: ___)*
- [ ] **RBAC** enforced on every write + report per the role matrix (storekeeper / receiving / pricing / transport / TM / OM / workshop / technician / finance / admin). *(Owner: ___)*
- [ ] **Site‑scoped visibility** — normal site users see only their `site_id` data (`sec_user_site`). *(Owner: ___)*

### Transport & secrets
- [ ] **HTTPS/TLS** everywhere via reverse proxy (nginx/Caddy); no plaintext HTTP. *(Owner: ___)*
- [ ] Secrets removed from source/committed `.env` → OS secret store / vault; rotate all creds that ever touched code. *(Owner: ___)*
- [ ] CORS allow‑list, security headers (helmet), and request rate limiting. *(Owner: ___)*
- [ ] Confirm all SQL is parameterized; keep `ORDER BY`/column names **allow‑listed** (already the pattern in `server.js` — do not regress). *(Owner: ___)*

### Data platform
- [ ] Stand up **one server database (PostgreSQL)** from `sql/schema.sql`; retire workstation SQLite. *(Owner: ___)*
- [ ] Enforce DB‑level **FK / CHECK / UNIQUE** constraints (already in schema) and **atomic transactions** (ledger row + balance update in one txn). *(Owner: ___)*

### Data safety
- [ ] **Automated, offsite, point‑in‑time backups** replacing the 30‑min file copies. *(Owner: ___)*
- [ ] **Tested restore** into a clean environment (an untested backup does not count). *(Owner: ___)*

### Audit
- [ ] Every create/update/approve/reverse stamped **who + when + before/after**; reversals require a reason; no silent edits to price/cost. *(Owner: ___)*

### Migration cutover — `docs/08`, `migration/`
- [ ] Exception queues worked down: **1,413 pending prices · 403 lube consumers · 308 labour rates · 286 job reconciliations · 1,515 lube meters**. *(Owner: ___)*
- [ ] Opening balances loaded and reconciled to control totals. *(Owner: ___)*
- [ ] **One parallel run** (legacy + UMMS side by side) reconciled; documented **go/no‑go**. *(Owner: ___)*
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
