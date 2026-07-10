# UMMS app (PostgreSQL) — one unified system

**One system, one login, one database** on the validated 74‑table PostgreSQL schema (`sql/schema.sql`) —
not separate apps. Shared foundation (auth, RBAC, site‑scope, numbering) and a **single inventory
engine** (`lib/inventory.js`) under all four domains: **Stores**, **Oil/Lubricant**, **Battery**, and
**Workshop Job‑Card + Costing** — wired together so a stock or oil issue flows straight into a job's
final cost.

## What works (verified end‑to‑end — `npm run smoke`, 31/31)

**One‑system integration (the point):** receive parts into stores → moving‑average cost rolls forward
(10@1500 + 10@1700 → **1,600**) → issue to a workshop job → the issue **auto‑posts as a job part** →
the job's material cost becomes the **real issued cost (4,800)**, valued at MWAC. Over‑issue is blocked
by the live stock balance. All in one app.

### Stores module (`routes/stores.js`)
- **Receive (GRN)** — posts a goods‑received note + an `IN` movement and rolls the moving‑average cost.
- **Issue** — checks the live balance, values at MWAC, posts an `OUT` movement + issue document, and —
  when `jobcard_id` is given — **creates the job part**, so stores and workshop are one flow.
- **Stock / items** — on‑hand, moving‑avg cost, and stock value per item‑location (site‑scoped).

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
| `db.js` | pg pool + `q/one/tx` (transactions run with constraints deferred for the FK graph) |
| `auth/password.js` | scrypt hashing (zero native deps) |
| `auth/mw.js` | session table, `authMiddleware`, `requirePerm`, `scopeSql` (row‑level site filter) |
| `lib/numbering.js` | `TYPE-SITE-YY-NNNNNN` via an atomic counter row |
| `routes/auth.js` | login / logout |
| `lib/inventory.js` | shared inventory engine — receive/issue/count over one MWAC ledger (stores + oil) |
| `routes/stores.js` | the Stores module (receive/GRN · issue · MWAC ledger · issue→job link) |
| `routes/oil.js` | the Oil/Lubricant module (receive · issue‑to‑vehicle · consumption · stock count) |
| `routes/battery.js` | the Battery module (serial lifecycle · event history) |
| `routes/jobcards.js` | the Workshop module (jobs · labour · parts · cost · close) |
| `server.js` | wiring |
| `seed.js` | minimal masters + `admin`/`foreman`/`viewer` users |
| `smoke.mjs` | end‑to‑end proof |

## Load your real data
`migrate-legacy.js` reads the two legacy SQLite books and loads the real masters (items, oil products,
fleet assets, batteries) into the unified DB — run it after `seed.js` (uses distinct `item_no` prefixes
so it never clashes with the demo rows). Verified against the real books: **2,743 spare items · 78
general · 21 oil products · 414 fleet assets · 37 batteries** loaded and served by the app.
```bash
STORES_DB=/path/inventory.db OIL_DB=/path/oilbook.db node migrate-legacy.js
```

## Run it (local)
```bash
# 1. PostgreSQL 16, load the schema
createdb umms && psql -d umms -f ../sql/schema.sql
# 2. app
cd app && npm install
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGDATABASE=umms   # PG* env, no secrets in code
npm run seed          # masters + users (admin/ChangeMe@Admin1, foreman/ChangeMe@Fore1, viewer/ChangeMe@View1)
npm start             # http://localhost:4000  (GET /health, POST /auth/login)
npm run smoke         # 12/12
```

## Next on this platform (see `BUILD_BACKLOG.md`)
- **Oil/Lubricant module** — build directly on this platform (products, issue ledger, consumption by
  asset) and migrate the real `oilbook` data in. *Choosing one unified system means oil becomes a
  module here — no need to touch its separate app.*
- **Battery module** — serial‑tracked lifecycle on `md_asset` + `hist_battery_event`.
- Load all real data via the ETLs in `migration/` (reconciled: LKR 12.19M, 0 orphan FKs).
- Outside‑repair into the job roll‑up; approval workflow (TM/OM) on close; unified UI + live dashboards.

> Config is env‑driven (`PG*`, `PORT`, `NODE_ENV`); no secrets in code. Cookies become `Secure`
> automatically under `NODE_ENV=production` behind TLS.
