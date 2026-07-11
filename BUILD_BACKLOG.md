# UMMS — What's left to build

Honest backlog to go from *"secured stores app + validated design"* to a *fully live unified system*.
Ordered by what gives value soonest. Sizing is rough effort, not a quote.

> **Direction chosen: ONE unified system** (one app, one login, one database) — not separate secured
> apps. This unblocks the oil work: oil becomes a **module built on the platform** with its data
> migrated in, so Tier 1's dependency on the separate oil app's source **no longer blocks go‑live**.
> The `app/` on PostgreSQL already runs **Stores + Workshop** in one login, with stock issues flowing
> straight into job cost.

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

## Tier 1 — Oil/Lubricant as a module on the unified platform  🟠 (unblocked)
*(Direction changed to one system, so this is no longer "secure the separate oil app" — it's build the
oil module here + migrate the data. No dependency on the oil app's source.)*
- [x] 🟠 Build the **Oil module** on the platform: products, receive/issue (shared engine),
  consumption by fleet asset, stock counts/variance — **done & verified** (22/22)
- [x] 🟢 Oil issues flow into job cost the same way stores issues do — **done** (shared engine)
- [x] 🟠 **Migrate** the real data — masters + opening balances done (`app/migrate-legacy.js` +
  `app/backfill-opening.js`): 2,743 spare items · 78 general · 21 oil products · 414 fleet assets · 37
  batteries, plus **2,143 opening stock balances (LKR 13.09M)**. *Optional: full historical txn replay.*

## Tier 2 — Workshop: Job Cards + Final Costing  🟠→🔴 (weeks) — **STARTED, running on PostgreSQL**
The backend is live in `app/` on the real schema (verified `npm run smoke`, 12/12).
- [x] 🟠 Backend API: create/list/get **job cards** (numbered, site‑scoped, permission‑gated) — **done**
- [x] 🟠 **Labour capture** — rate from `md_labour_rate` by grade × effective date — **done**
- [x] 🟠 Parts (material vs general + provisional), **cost rollup into `cost_job_summary` + variance + close gating** — **done**
- [x] 🔴 **The key integration:** a **stores issue posts straight to a job card** so material cost flows from the real issue at MWAC — **done & verified** (17/17). Oil issues will do the same once the oil module lands.
- [ ] 🟠 Outside‑repair capture into the rollup; approval workflow (TM/OM) on close
- [ ] 🟠 UI: job‑card entry screen + the costing view (prototypes exist to build from)
- [ ] 🟡 Job cost reports / export

## Tier 3 — Unify into one UMMS platform  🔴 (months) — **foundation STARTED**
The blueprint + **validated 76‑table PostgreSQL schema** + **tested ETLs** exist; the app is now begun
(`app/` runs on PostgreSQL with shared auth/RBAC/site‑scope/numbering + the Workshop module).
- [x] 🔴 Build the app on `sql/schema.sql` — **all four domain backends + a unified web UI + a deploy
  kit done** (Stores · Oil · Battery · Workshop in one login/DB/engine, 31/31; SPA at `/` on real data;
  `app/deploy/` = Docker Compose Postgres+app+nginx TLS + one‑command VPS bootstrap, self‑seeding on
  first boot). *Opening stock balances backfilled too (`app/backfill-opening.js`).*
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
