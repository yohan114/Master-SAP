# UMMS app — one unified system (PostgreSQL **or** SQLite)

**One system, one login, one database** on the validated 74‑table schema — not separate apps. Shared
foundation (auth, RBAC, site‑scope, numbering) and a **single inventory engine** (`lib/inventory.js`)
under all four domains: **Stores**, **Oil/Lubricant**, **Battery**, and **Workshop Job‑Card + Costing** —
wired together so a stock or oil issue flows straight into a job's final cost.

**Pick your database engine at boot — the app is identical on both:**
- **PostgreSQL** (default) — for the server/VPS deployment. Schema: `sql/schema.sql`.
- **SQLite** (`DB_ENGINE=sqlite`) — a single local file, zero DB server to run. Schema:
  `sql/schema.sqlite.sql` (generated from the Postgres schema — `node sql/gen-sqlite-schema.js`).
  Great for a laptop trial, a single‑PC install, or matching the legacy SQLite books. The whole
  suite passes **43/43 on both engines** with the same code (`db.js` translates the handful of
  Postgres‑isms and picks the engine from `DB_ENGINE` / `SQLITE_DB`).

## What works (verified end‑to‑end — `npm run smoke`, 43/43)

**One‑system integration (the point):** receive parts into stores → moving‑average cost rolls forward
(10@1500 + 10@1700 → **1,600**) → issue to a workshop job → the issue **auto‑posts as a job part** →
the job's material cost becomes the **real issued cost (4,800)**, valued at MWAC. Over‑issue is blocked
by the live stock balance. All in one app.

### Stores module (`routes/stores.js`)
- **Receive (GRN)** — posts a goods‑received note + an `IN` movement and rolls the moving‑average cost.
- **Issue** — checks the live balance, values at MWAC, posts an `OUT` movement + issue document, and —
  when `jobcard_id` is given — **creates the job part**, so stores and workshop are one flow.
- **Stock / items** — on‑hand, moving‑avg cost, and stock value per item‑location (site‑scoped).

### Requisitions — MRN module (`routes/mrn.js`)
- **Raise → approve → fulfil.** A Material Requisition Note is the demand document that precedes an
  issue: raise it (DRAFT) with request lines, approve it (sets approved qty), then **fulfil from stock**,
  which posts the issue at MWAC against the MRN, increments `issued_qty`, and rolls the line/header to
  `PARTIAL` / `CLOSED`. Stock short of the approved qty is left open for a later top‑up.
- **Two‑mode lines — General vs Other** (see [`docs/14`](../docs/14-material-request-item-selection.md)):
  a line is either a **General** item picked from the master (only `is_stockable` items qualify — these
  carry availability + min/reorder and are issued from stock) **or** an **Other** item typed by hand for
  rare/one‑time things (bypasses stock, but must carry description + qty + unit + reason, and goes to
  purchase). Typing an item that already exists in the master is **blocked**, so the catalogue stays clean.
- **Same engine, same flow.** Fulfilment of general lines reuses the shared issue engine, so an MRN raised
  against a job card posts its parts straight onto that job — one flow, no re‑keying.

### Oil / Lubricant module (`routes/oil.js`)
- **Receive / issue** on the same engine — an oil issue requires a **vehicle/machine** (`asset_id`) and
  can also post to a job card. Non‑lubricants are rejected.
- **Consumption by asset** — litres + value of each lubricant issued per vehicle over a date range
  (spots abnormal consumption / leaks).
- **Stock count** — physical vs book with variance and an optional auto‑adjust (`ADJ` movement).

### Battery module (`routes/battery.js`)
- **Serial‑true lifecycle** — each physical battery is one record; register → install → transfer →
  return → scrap, each an append‑only `hist_battery_event`. **Original vs current vehicle** is always
  preserved, and the full history is queryable per battery.

### Workshop module (`routes/jobcards.js`)
- **Auth + RBAC** — session login; `requirePerm` gates every write (`viewer` cannot create a job → 403).
- **Job cards** — create (numbered `JOB-<SITE>-YY-NNNNNN`), list (site‑scoped), get with lines + cost.
- **Labour** — rate resolved from `md_labour_rate` by the technician's grade, effective on the labour
  date; `labour_cost = hours·rate + ot_hours·rate·ot_multiplier` (e.g. 8·500 + 2·750 = **5,500**).
- **Parts** — material vs **general** routing (general items roll to `general_cost`); `is_provisional`
  flag carried through.
- **Cost roll‑up** — `cost_job_summary` = material + labour + outside‑repair + general; **variance** vs
  estimate; `is_provisional` set if any provisional line exists.
- **Close gating** — cannot close before a cost roll‑up, or while any cost is provisional (→ 409).

## Files
| Path | Purpose |
|---|---|
| `db.js` | dual‑engine data layer — `q/one/tx/exec`; Postgres (pool, deferred constraints) **or** SQLite (`node:sqlite`), selected by `DB_ENGINE`/`SQLITE_DB` |
| `auth/password.js` | scrypt hashing (zero native deps) |
| `auth/mw.js` | session table, `authMiddleware`, `requirePerm`, `scopeSql` (row‑level site filter) |
| `lib/numbering.js` | `TYPE-SITE-YY-NNNNNN` via an atomic counter row |
| `routes/auth.js` | login / logout |
| `lib/inventory.js` | shared inventory engine — receive/issue/count over one MWAC ledger (stores + oil) |
| `routes/stores.js` | the Stores module (receive/GRN · issue · MWAC ledger · issue→job link) |
| `routes/mrn.js` | the Requisitions module (MRN raise · approve · fulfil‑from‑stock → issue) |
| `routes/oil.js` | the Oil/Lubricant module (receive · issue‑to‑vehicle · consumption · stock count) |
| `routes/battery.js` | the Battery module (serial lifecycle · event history) |
| `routes/jobcards.js` | the Workshop module (jobs · labour · parts · cost · close) |
| `server.js` | wiring |
| `seed.js` | minimal masters + `admin`/`foreman`/`viewer` users |
| `smoke.mjs` | end‑to‑end proof |

## The web UI
A single-page UI is served by the same app at `/` (see `public/`): login → dashboard (live KPIs) →
Stores · Requisitions · Oil · Battery · Workshop. It drives the same APIs — browse the real catalog,
receive/issue stock, raise/approve/fulfil requisitions, register/install batteries and view their
history, and run the full job‑costing flow (create → labour → issue parts → compute → close). No build
step; vanilla JS, theme‑aware.

## Load your real data
`migrate-legacy.js` reads the two legacy SQLite books and loads the real masters (items, oil products,
fleet assets, batteries) into the unified DB — run it after `seed.js` (uses distinct `item_no` prefixes
so it never clashes with the demo rows). Verified against the real books: **2,743 spare items · 78
general · 21 oil products · 414 fleet assets · 37 batteries** loaded and served by the app.
```bash
STORES_DB=/path/inventory.db OIL_DB=/path/oilbook.db node migrate-legacy.js
```

## Run it (local)

### Option A — SQLite (simplest: no database server)
```bash
cd app && npm install
export DB_ENGINE=sqlite SQLITE_DB=./umms.sqlite   # one local file
node init-db.js       # loads sql/schema.sqlite.sql into a fresh file
npm run seed          # masters + users (admin/ChangeMe@Admin1, foreman/ChangeMe@Fore1, viewer/ChangeMe@View1)
npm start             # http://localhost:4000  (GET /health, POST /auth/login)
npm run smoke         # 43/43  (start the server first, in another shell)
```

### Option B — PostgreSQL
```bash
# 1. PostgreSQL 16, load the schema
createdb umms && psql -d umms -f ../sql/schema.sql
# 2. app
cd app && npm install
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGDATABASE=umms   # PG* env, no secrets in code
npm run seed          # masters + users (admin/ChangeMe@Admin1, foreman/ChangeMe@Fore1, viewer/ChangeMe@View1)
npm start             # http://localhost:4000  (GET /health, POST /auth/login)
npm run smoke         # 43/43
```

The same `migrate-legacy.js` / `backfill-opening.js` work under either engine (prefix `DB_ENGINE=sqlite`
to load into the SQLite file instead of Postgres).

## Next on this platform (see `BUILD_BACKLOG.md`)
- **Oil/Lubricant module** — build directly on this platform (products, issue ledger, consumption by
  asset) and migrate the real `oilbook` data in. *Choosing one unified system means oil becomes a
  module here — no need to touch its separate app.*
- **Battery module** — serial‑tracked lifecycle on `md_asset` + `hist_battery_event`.
- Load all real data via the ETLs in `migration/` (reconciled: LKR 12.19M, 0 orphan FKs).
- Outside‑repair into the job roll‑up; approval workflow (TM/OM) on close; unified UI + live dashboards.

> Config is env‑driven (`DB_ENGINE`/`SQLITE_DB` or `PG*`, plus `PORT`, `NODE_ENV`); no secrets in code.
> Cookies become `Secure` automatically under `NODE_ENV=production` behind TLS.
