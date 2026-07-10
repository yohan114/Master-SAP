# UMMS storesdb — Go‑Live Runbook

Take the **secured storesdb app** from "tested" to "running in production." Two paths:
**A. Docker** (recommended — portable, self‑contained) and **B. Direct on a Linux host** (systemd).
Both end at the same place: the hardened app behind an nginx TLS proxy on your domain.

The app runs on **SQLite** (`inventory.db`) — production‑fine for a single‑site internal tool at this
scale. Nothing here needs PostgreSQL.

> One‑time truth check before you start: this port only *adds* auth/RBAC/MFA/site‑scope/audit/CORS —
> it does not change your business logic. Back up your current `inventory.db` first.

---

## ⚡ Fastest path — one command on a fresh Ubuntu/Debian VPS

If you have a VPS + domain, this does everything (installs Docker + certbot, ports the app, issues the
TLS cert, templates nginx, brings the stack up, seeds your DB, verifies):

```bash
# 0. Point DNS: an A record for your domain -> this VPS's public IP. Open ports 80 + 443.
# 1. Get the code + your app onto the VPS:
git clone <this-repo-url> && cd Master-SAP
#    copy your storesdb app to /opt/umms/storesdb (server.js, db.js, inventory.db, item_tracker.html, package.json)
# 2. Go live:
sudo DOMAIN=your.domain EMAIL=you@your.domain APP_DIR=/opt/umms/storesdb \
     bash deploy/bootstrap-vps.sh
```

It ends by printing your live URL (`https://your.domain/login.html`) and the two cron lines for cert
renewal (`deploy/renew-cert.sh`) + nightly DB backup. Then do the **Lock it down** step below (change
seeded passwords, enable MFA). If anything fails mid‑way it's safe to re‑run — every step is idempotent.

The manual, step‑by‑step paths below are for when you want more control (or aren't on apt/Ubuntu).

---

## 0. Prerequisites
- A Linux host (VM or on‑prem) with a public DNS name pointing at it (e.g. `umms.example.com`).
- Ports 80 + 443 reachable.
- **Docker path:** Docker + Docker Compose plugin.
- **Direct path:** Node 20+ (22 recommended), nginx, certbot.
- A copy of your real storesdb app directory (with `server.js`, `db.js`, `inventory.db`, `item_tracker.html`, `package.json`).

## 1. Port your app (both paths)
```bash
# from the Master-SAP repo:
cp -r /path/to/your/storesdb /opt/umms/storesdb        # work on a copy, not the original
cp /opt/umms/storesdb/inventory.db /opt/umms/inventory.db.pre-golive.bak   # BACK UP the data
deploy/apply-port.sh /opt/umms/storesdb --seed         # applies patch, drops in auth/, seeds users
```
`--seed` prints the placeholder logins. **Change every password immediately** (step 5).

## 2A. Docker path
```bash
cp deploy/.env.production.example deploy/.env          # edit: NODE_ENV, PORT, CORS_ORIGINS, HOME_SITE_ID
mkdir -p deploy/certs
# TLS cert: use certbot (below) or drop your cert here as fullchain.pem + privkey.pem
cp /etc/letsencrypt/live/umms.example.com/fullchain.pem deploy/certs/
cp /etc/letsencrypt/live/umms.example.com/privkey.pem   deploy/certs/
# edit deploy/nginx/umms.conf: replace umms.example.com with your host
APP_SRC=/opt/umms/storesdb docker compose -f deploy/docker-compose.yml up -d --build
# seed the DB into the named volume (first run only):
docker cp /opt/umms/storesdb/inventory.db "$(docker compose -f deploy/docker-compose.yml ps -q app)":/data/inventory.db
docker compose -f deploy/docker-compose.yml restart app
```
Get a cert with certbot (HTTP‑01) before bringing nginx up on 443, or run nginx on 80 first and use
the `./certbot-webroot` mount for the challenge.

## 2B. Direct (systemd) path
```bash
cp deploy/.env.production.example /opt/umms/storesdb/.env    # edit values; INVENTORY_DB=/opt/umms/storesdb/inventory.db
sudo useradd -r -s /usr/sbin/nologin umms && sudo chown -R umms:umms /opt/umms/storesdb
sudo cp deploy/umms-storesdb.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now umms-storesdb
# nginx:
sudo certbot --nginx -d umms.example.com                    # issues + installs the cert
sudo cp ops/proxy/nginx-umms.conf /etc/nginx/conf.d/umms.conf   # edit server_name; proxies to 127.0.0.1:4000
sudo nginx -t && sudo systemctl reload nginx
```

## 3. Verify it's live
```bash
curl -fsS https://umms.example.com/health            # {"ok":true,...}
curl -sk -o /dev/null -w '%{http_code}\n' https://umms.example.com/item_tracker.html   # 302 -> /login.html (unauthenticated)
```
Then in a browser: log in at `/login.html`, confirm the tracker loads, and that an unauthenticated
`GET /api/items` returns 401.

## 4. Enable MFA for admin/finance
Log in as admin, then:
```bash
curl -X POST https://umms.example.com/auth/mfa/setup -b cookie.txt   # returns secret + otpauth URI
# scan the otpauth URI in Google Authenticator / Authy, then:
curl -X POST https://umms.example.com/auth/mfa/enable -b cookie.txt -H 'content-type: application/json' -d '{"token":"123456"}'
```

## 5. Lock it down (do NOT skip)
- **Change all seeded passwords** immediately (`admin`, `keeper`, `pricing`). They are placeholders.
- Confirm `NODE_ENV=production` (cookies are Secure) and `TRUST_PROXY=1` (real client IPs in the audit log).
- Rotate anything that ever lived in code, including the old `E&CWorkshop` delete password.

## 6. Backups (nightly)
Point the provided backup at your DB and cron it:
```bash
# SQLite: a consistent copy every night + keep 14 days
0 1 * * *  sqlite3 /opt/umms/storesdb/inventory.db ".backup '/backups/inventory-$(date +\%F).db'" && find /backups -name 'inventory-*.db' -mtime +14 -delete
```
(For the PostgreSQL edition later, use `ops/backup/pg_backup.sh` instead.)

## 7. Rollback
- Docker: `docker compose -f deploy/docker-compose.yml down` and restore `inventory.db.pre-golive.bak`.
- Direct: `sudo systemctl stop umms-storesdb`, restore the backup, restart your old process.
Because the port is additive, rolling back the app is just running your previous `server.js`; the data
is unchanged except for the added `sec_*`/`audit_log` tables and a `site_id` column (both harmless to the old app).

---

### What "live" gives you on day one
Real per‑user login, role‑based access (keeper/pricing/admin), optional 2FA, per‑site data isolation
(reads **and** writes), a full who/when/before‑after audit trail, HTTPS with security headers, and
nightly backups — running against your real stores data.
