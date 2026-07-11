# Master‑SAP — UMMS (Unified Master Management System)

**One system for Transport Stores, Oil/Lubricant, Battery Lifecycle, and Workshop Job‑Card Costing —
one login, one database.**

What began as a design blueprint is now a **working, deployable application**. Four operations that
used to be separate apps and Excel books run as **modules of a single master system** on PostgreSQL,
wired together so a stock or oil issue flows straight into a workshop job's final cost.

> Status: the backend of all four domains + a unified web UI + a one‑command deploy kit are **built and
> tested** (`app/`, 56/56 end‑to‑end), running on the **real migrated data** (2,825 items · 414 fleet
> assets · 37 batteries · **LKR 13.09M opening stock**). See [`BUILD_BACKLOG.md`](BUILD_BACKLOG.md).

---

## The system (`app/`)

One Node app on **PostgreSQL or SQLite** (same code, engine chosen at boot). Shared foundation (auth,
RBAC, per‑site scope, `TYPE‑SITE‑YY‑NNNNNN` numbering) and a **single moving‑average inventory engine**
under four modules:

| Module | What it does |
|---|---|
| **Stores** | item master · receive (GRN) · issue · moving‑average stock ledger |
| **Requisitions (MRN)** | raise → approve → fulfil‑from‑stock (posts the issue at MWAC, tracks partial/closed) |
| **Procurement** | Local/Head‑Office PO → receive (GRN) → pending‑price → confirm (revalues stock by the variance) |
| **Oil / Lubricant** | receive · issue‑to‑vehicle · consumption‑by‑asset · book‑vs‑physical stock counts |
| **Battery** | serial‑true lifecycle: register → install → transfer → return → scrap, with full history |
| **Workshop** | job cards · labour (auto‑rated by grade) · parts · cost roll‑up · variance · close‑gating |

**The unification:** a stores or oil issue can post straight onto a job card, so the job's material
cost is the **real issued cost at moving‑average valuation** — not a re‑keyed number.

### Run it locally

Runs on **PostgreSQL or SQLite** — same code, pick the engine at boot.

```bash
# --- SQLite (simplest: no DB server, one local file) ---
cd app && npm install
export DB_ENGINE=sqlite SQLITE_DB=./umms.sqlite
node init-db.js              # loads sql/schema.sqlite.sql into a fresh file
npm run seed && npm start    # http://localhost:4000  (login: admin / ChangeMe@Admin1)
npm run smoke                # 56/56 end-to-end

# --- PostgreSQL (server / VPS) ---
createdb umms && psql -d umms -f sql/schema.sql
cd app && npm install
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGDATABASE=umms
npm run seed && npm start    # http://localhost:4000
npm run smoke                # 56/56 end-to-end
```
Load your real data (from a machine with the legacy SQLite books):
```bash
STORES_DB=/path/inventory.db OIL_DB=/path/oilbook.db node migrate-legacy.js   # real catalog
STORES_DB=/path/inventory.db OIL_DB=/path/oilbook.db node backfill-opening.js  # opening stock
```

### Deploy it (one command)
```bash
sudo DOMAIN=your.domain EMAIL=you@your.domain bash app/deploy/bootstrap-vps.sh
```
Stands up **PostgreSQL + the app + nginx TLS** in Docker on a fresh Ubuntu/Debian VPS; the app loads
its schema and seeds itself on first boot. Full steps: [`app/deploy/README.md`](app/deploy/README.md)
and [`app/README.md`](app/README.md).

---

## The blueprint (design docs, read in this order)

The application implements this design. Start with the Design Contract.

| # | Document | What's inside |
|---|----------|---------------|
| 00 | [Design Contract](docs/00-design-contract.md) | **Start here.** Naming, shared masters, numbering, status vocabularies, valuation, integrity rules. |
| 01 | [Business Architecture](docs/01-business-architecture.md) | Target‑state; architecture layers; cross‑module scenario. |
| 02 | [Module Breakdown](docs/02-module-breakdown.md) | Every module: masters, transactions, approvals, reports, alerts. |
| 03 | [Database Design](docs/03-database-design.md) | Relational schema, keys, ledger & valuation logic. |
| 04 | [Stock Workflows](docs/04-stock-workflows.md) | Stores/lubricant/battery workflows, status maps, validations. |
| 05 | [Job Card & Costing](docs/05-jobcard-and-costing.md) | Job lifecycle, approvals, labour, cost formulas, close gating. |
| 06 | [Dashboards & KPIs](docs/06-dashboards-kpi.md) | Executive/operational dashboards, KPI catalog. |
| 07 | [Roles & Permissions](docs/07-roles-permissions.md) | Role catalog, permission matrix, site visibility, SoD, audit. |
| 08 | [Data Migration](docs/08-data-migration.md) | Staging, mapping, validation, reconciliation, cutover. |
| 09 | [UI/UX Direction](docs/09-uiux-design.md) | Command‑center design language, components, wireframes. |
| 10 | [Reports & Documents](docs/10-reports-documents.md) | Report catalog + printable layouts. |
| 11 | [Integration & Future‑Readiness](docs/11-integration.md) | Excel, barcode/QR, notifications, API, BI, optional SAP. |
| 12 | [Roadmap, Appendices & Risks](docs/12-roadmap-appendices-risks.md) | Phase plan, menus, numbering, alerts, risk register. |
| 13 | [Auth & RBAC Design](docs/13-auth-rbac-design.md) | Login, hashing, sessions, permission middleware, site scoping. |
| 14 | [Material Request — General vs Other items](docs/14-material-request-item-selection.md) | Two‑mode request lines: master‑list general (stock‑controlled) vs typed non‑stock items. |

---

## Core design decisions

- **Shared masters, zero duplication.** `md_item` holds every material (store/lubricant/spare/general/
  battery model); `md_asset` every vehicle/machine. One supplier, employee, location, UoM list.
- **Single stock ledger.** Every receipt/issue/transfer/adjustment posts an append‑only
  `mv_stock_ledger` row; `inv_stock_balance` is the on‑hand + moving‑average‑cost snapshot.
- **Serial‑true battery lifecycle** in `hist_battery_event`, preserving original‑vs‑current asset.
- **Approval‑gated job closure** — no close while any cost is provisional or before a roll‑up exists.
- **Auditable, site‑scoped security** — reads and writes are scoped to a user's site(s).

Prefixes (`md_`/`tx_`/`txl_`/`mv_`/`inv_`/`hist_`/`cost_`/`sec_`…) and numbering (`TYPE‑SITE‑YY‑NNNNNN`)
are defined once in the [Design Contract](docs/00-design-contract.md).

---

## Repository layout

```
Master-SAP/
├── app/                 # ★ the unified system — Node + PostgreSQL (4 modules, web UI, deploy kit)
│   ├── routes/          #   stores · oil · battery · jobcards · auth
│   ├── lib/inventory.js #   shared moving-average inventory engine
│   ├── public/          #   the single-page web UI
│   ├── deploy/          #   Docker Compose (Postgres + app + nginx) + one-command VPS bootstrap
│   ├── migrate-legacy.js, backfill-opening.js, seed.js, smoke.mjs
│   └── README.md
├── sql/schema.sql       # the validated 74-table PostgreSQL schema the app runs on
│   └── schema.sqlite.sql #   SQLite build of the same schema (gen-sqlite-schema.js) for DB_ENGINE=sqlite
├── docs/                # the solution blueprint (00–13)
├── reference/           # storesdb security port + runnable auth reference (the earlier, stores-only path)
├── deploy/              # go-live kit for the standalone secured stores app (localhost + VPS)
├── migration/           # tested legacy-import ETLs + costing engine + playbook
├── ops/                 # backup/restore drills, nginx TLS config, reconciliation
├── ui/prototype.html    # command-center UI prototype
├── BUILD_BACKLOG.md     # what's built vs what's left
└── PRODUCTION_READINESS.md  # P0/P1/P2 go-live checklist
```

## Go‑live checklist
1. **DNS** — point a domain at your VPS; open ports 80/443.
2. **Deploy** — `sudo DOMAIN=… EMAIL=… bash app/deploy/bootstrap-vps.sh`.
3. **Load your data** — `migrate-legacy.js` then `backfill-opening.js` (via `docker compose … exec app`).
4. **Lock down** — change the seeded passwords; back up the `umms-pgdata` volume nightly; cert
   auto‑renewal cron is printed by the bootstrap.
