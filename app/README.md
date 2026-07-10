# UMMS app (PostgreSQL) — Workshop module

The first runnable slice of the **unified UMMS platform** on the validated 74‑table PostgreSQL schema
(`sql/schema.sql`). It stands up the shared foundation (auth, RBAC, site‑scope, document numbering) and
the **Workshop Job‑Card + Final Costing** module (Tier 2 of `BUILD_BACKLOG.md`).

## What works (verified end‑to‑end — `npm run smoke`, 12/12)
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
| `routes/jobcards.js` | the Workshop module (jobs · labour · parts · cost · close) |
| `server.js` | wiring |
| `seed.js` | minimal masters + `admin`/`foreman`/`viewer` users |
| `smoke.mjs` | end‑to‑end proof |

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
- **Outside‑repair** capture into the roll‑up; approval workflow (TM/OM) on job close.
- **The cross‑module link:** consume real **stores/oil issues** as job parts (replaces the manual part
  line) — the "material cost flows into job cost" integration.
- Shared masters + data load (ETLs in `migration/`), dashboards, single sign‑on across modules.

> Config is env‑driven (`PG*`, `PORT`, `NODE_ENV`); no secrets in code. Cookies become `Secure`
> automatically under `NODE_ENV=production` behind TLS.
