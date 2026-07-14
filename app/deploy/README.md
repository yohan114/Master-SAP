# Deploy the unified UMMS platform

Stand up the whole system (PostgreSQL + the app + nginx TLS) with one command. The app **loads the
schema and seeds itself on first boot** — no manual DB setup.

## Fastest path — one command on a fresh Ubuntu/Debian VPS
```bash
# 0. DNS: A record for your domain -> the VPS. Open ports 80 + 443.
# 1. Get the code:
git clone <this-repo-url> && cd Master-SAP && git checkout claude/master-management-system-uetj7w
# 2. Go live:
sudo DOMAIN=your.domain EMAIL=you@your.domain bash app/deploy/bootstrap-vps.sh
```
It installs Docker + certbot, generates a DB password, issues the TLS cert, templates nginx for your
domain, and brings the stack up. Ends by printing the live URL. **Then log in and change the admin
password.**

## Manual (any Docker host)
```bash
cp app/deploy/.env.example app/deploy/.env      # set DB_PASSWORD
# put fullchain.pem + privkey.pem in app/deploy/certs/, set the domain in app/deploy/nginx/umms.conf
docker compose -f app/deploy/docker-compose.yml --env-file app/deploy/.env up -d --build
```

## Files
| File | Purpose |
|---|---|
| `Dockerfile` | app image (Node 22, non‑root, `/health` probe); first boot loads `sql/schema.sql` + seeds |
| `entrypoint.sh` | waits for Postgres → `init-db.js` (schema if fresh) → `seed.js` (fresh only) → `server.js` |
| `docker-compose.yml` | Postgres 16 + app + nginx TLS; DB on a named volume |
| `nginx/umms.conf` | TLS termination, security headers, login rate‑limit |
| `.env.example` | `DB_PASSWORD` |
| `bootstrap-vps.sh` | one‑command VPS go‑live (Docker + certbot + up) |

## Load your real data
Once up, from a machine that has the legacy SQLite books:
```bash
STORES_DB=/path/inventory.db OIL_DB=/path/oilbook.db \
  docker compose -f app/deploy/docker-compose.yml exec app node migrate-legacy.js
```

## After go‑live
- **Change the seeded passwords** (`admin`/`foreman`/`keeper`/`viewer`) immediately.
- Cert auto‑renewal cron is printed by the bootstrap (webroot, no downtime).
- Back up the `umms-pgdata` volume nightly (`docker compose exec db pg_dump -U umms umms | gzip > …`).
