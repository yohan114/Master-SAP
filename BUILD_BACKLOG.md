# UMMS — What's left to build

Honest backlog to go from *"secured stores app + validated design"* to a *fully live unified system*.
Ordered by what gives value soonest. Sizing is rough effort, not a quote.

**Legend:** ✅ done · 🟢 deploy‑only (no building) · 🟡 small build · 🟠 medium build · 🔴 large build ·
⛔ blocked (needs something from you)

---

## Tier 0 — Go live with what's already built  🟢 (hours, your infra)
Nothing to *build* — just run it. Everything here is scripted + verified.
- [ ] 🟢 Run the stores app locally to try it (`node deploy/apply-port.mjs … && node server.js`) — **kit done**
- [ ] 🟢 Deploy stores app to the VPS (`sudo … bash deploy/bootstrap-vps.sh`) — **kit done**
- [ ] 🟢 Change the 3 seeded passwords; enable MFA for admin/finance
- [ ] 🟢 Cron the cert renewal (`renew-cert.sh`) + nightly DB backup
- [ ] 🟢 Rotate any old credential that touched code (incl. `E&CWorkshop`); freeze the old app read‑only at cutover

## Tier 1 — Bring the Oil app to the same bar  🟡 (a few days) ⛔ needs oil source
The oil app (`Oil Stock System` / `oilbook.db`) is **more modern than stores — it already has auth**
(`users` + `role` + `sessions`, `projects`/`sites`/`user_projects` scoping). So it does **not** need the
stores‑style "add auth" port. What it needs:
- [ ] ⛔ **Share the oil app's full source** (its real `server.js`/routes + `package.json` + UI) — I only have `schema.sql` + `ledger.js`
- [ ] 🟡 Security audit of its existing auth/session/RBAC + SQL‑injection pass
- [ ] 🟡 Add the missing pieces to match stores: **MFA**, **who/when/before‑after audit trail**, **CORS allow‑list**
- [ ] 🟡 Its own **localhost + VPS deploy kit** (Docker/systemd/nginx/runbook)

## Tier 2 — Workshop: Job Cards + Final Costing  🟠→🔴 (weeks) — **STARTED, running on PostgreSQL**
The backend is live in `app/` on the real schema (verified `npm run smoke`, 12/12).
- [x] 🟠 Backend API: create/list/get **job cards** (numbered, site‑scoped, permission‑gated) — **done**
- [x] 🟠 **Labour capture** — rate from `md_labour_rate` by grade × effective date — **done**
- [x] 🟠 Parts (material vs general + provisional), **cost rollup into `cost_job_summary` + variance + close gating** — **done**
- [ ] 🟠 Outside‑repair capture into the rollup; approval workflow (TM/OM) on close
- [ ] 🔴 **The key integration:** link **stores issues + oil issues to a job card** so material cost flows from real issues (needs a job reference on issues in both apps)
- [ ] 🟠 UI: job‑card entry screen + the costing view (prototypes exist to build from)
- [ ] 🟡 Job cost reports / export

## Tier 3 — Unify into one UMMS platform  🔴 (months) — **foundation STARTED**
The blueprint + **validated 74‑table PostgreSQL schema** + **tested ETLs** exist; the app is now begun
(`app/` runs on PostgreSQL with shared auth/RBAC/site‑scope/numbering + the Workshop module).
- [~] 🔴 Build the app on `sql/schema.sql` — backend APIs + UI + dashboards (**foundation + first module done**; more modules + UI + live dashboards remain — today dashboards are static renders)
- [ ] 🟠 **Shared masters** — one item master, one asset/vehicle master, one supplier/employee/location/UoM (dedup already prototyped: 1,339 assets, 2,730 items)
- [ ] 🟠 Load all four domains into PostgreSQL (ETLs done + reconciled — LKR 12.19M, 0 orphan FKs) and keep them in sync until cutover
- [ ] 🟠 Cross‑module engine: single **stock ledger**, **MWAC valuation**, effective‑date pricing, approval workflows
- [ ] 🟠 Single sign‑on + one RBAC model across all modules; per‑site visibility
- [ ] 🟡 Real live dashboards + KPIs (replace the prototype images)
- [ ] 🟠 Cutover: freeze the separate apps, switch users to UMMS

## Tier 4 — Enterprise / later  🔴 (optional, future)
- [ ] 🔴 SAP integration (MM / PM / CO) per the integration blueprint
- [ ] 🟠 PostgreSQL HA + point‑in‑time recovery (backup/restore drills already scripted in `ops/`)
- [ ] 🟠 Forecasting / reorder analytics, mobile access, barcode/serial scanning

---

## Recommended sequence
1. **Tier 0 now** — get the stores app live this week (real value, zero building).
2. **Tier 1 next** — once you send the oil source, secure + deploy it (a few days). Two solid live apps.
3. **Tier 2** — build the workshop/costing module (the biggest missing *business* capability).
4. **Tier 3** — unify onto PostgreSQL when you want one login + cross‑module costing.
5. **Tier 4** — SAP + advanced, when the above is bedded in.

## What unblocks the most, fastest
- **Oil source** → unblocks all of Tier 1.
- **A decision: two secured apps now, or unified platform** → sets whether Tier 2/3 are built per‑app or on PostgreSQL.
