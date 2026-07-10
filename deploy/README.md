# deploy/ — Go‑live kit for the secured storesdb app

Turnkey deployment of the hardened storesdb app (auth · RBAC · MFA · site‑scope · audit · CORS · TLS).
Start with **`RUNBOOK.md`** — it is the step‑by‑step procedure. This folder contains:

| File | Purpose |
|---|---|
| `RUNBOOK.md` | **The go‑live procedure** — one‑command VPS path + manual Docker/systemd paths, verification, MFA, backups, rollback |
| `bootstrap-vps.sh` | **One‑shot go‑live** on a fresh Ubuntu/Debian VPS: installs Docker+certbot, applies the port, issues the TLS cert, templates nginx with your domain, brings the stack up, seeds your DB, verifies |
| `renew-cert.sh` | No‑downtime Let's Encrypt renewal (webroot) + nginx reload — put on daily cron |
| `apply-port.sh` | Idempotently applies `reference/storesdb-auth-port/` to a copy of your app (patch + auth files + deps + seed) |
| `Dockerfile` | Builds the secured app image (non‑root, `/health` probe); build context = your ported app dir |
| `docker-compose.yml` | Production stack — app + nginx TLS proxy, persistent `inventory.db` volume |
| `nginx/umms.conf` | TLS termination + security headers + login throttle, proxies to the app container |
| `.env.production.example` | Environment template (`NODE_ENV`, `PORT`, `INVENTORY_DB`, `TRUST_PROXY`, `CORS_ORIGINS`, `HOME_SITE_ID`) |
| `umms-storesdb.service` | systemd unit for the direct (non‑Docker) path |

Runs on **SQLite** — production‑fine for a single‑site internal tool at this scale; no PostgreSQL
required to go live. The full unified UMMS platform (PostgreSQL, all four domains) is a separate build
tracked by `docs/` + `sql/schema.sql`.

**Boundary:** the final deploy runs on *your* host (DNS, certs, and the box are yours). Everything here
was verified by applying the port to a copy of the real app and booting it end‑to‑end.
