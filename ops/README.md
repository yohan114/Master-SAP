# UMMS — Operations (backups, restore drills, TLS)

Covers production‑readiness blockers **P0 #4 (data safety)** and **P0 #3 transport** from
`PRODUCTION_READINESS.md`.

## Backups

`backup/pg_backup.sh` — compressed custom‑format `pg_dump` + SHA‑256 checksum + retention, with
optional at‑rest encryption (`age`) and offsite copy (`OFFSITE_CMD`). Custom format lets you do
parallel and selective (single‑table) restores.

```bash
# hourly cron
0 * * * *  BACKUP_DIR=/var/backups/umms RETENTION_DAYS=14 /opt/umms/ops/backup/pg_backup.sh
# encrypted + offsite example
AGE_RECIPIENT=age1... OFFSITE_CMD="aws s3 cp --sse aws:kms" /opt/umms/ops/backup/pg_backup.sh
```

**3‑2‑1:** keep ≥3 copies, on 2 media, 1 offsite. Set `OFFSITE_CMD` (S3/rclone) and `AGE_RECIPIENT`
so backups leave the box encrypted.

### Point‑in‑time recovery (advanced, recommended for prod)
Logical dumps give you daily/hourly recovery points. For minutes‑level RPO, add WAL archiving:
```
# postgresql.conf
wal_level = replica
archive_mode = on
archive_command = 'test ! -f /var/backups/umms/wal/%f && cp %p /var/backups/umms/wal/%f'
```
Take a weekly base backup with `pg_basebackup -D - -Ft -z` and keep the WAL stream → restore to any
point in time. (Managed Postgres — RDS/Cloud SQL — gives PITR out of the box; prefer it if available.)

## Restore drills — *the* thing that makes a backup real

`backup/pg_restore_drill.sh` restores the latest dump into a scratch DB and **verifies row counts
and total stock value match the live DB**, then drops the scratch DB. Schedule it weekly; page on
failure.

```bash
0 3 * * 0  BACKUP_DIR=/var/backups/umms /opt/umms/ops/backup/pg_restore_drill.sh
```

> Verified in this repo: dump of the loaded UMMS DB → restore into a fresh DB → all key‑table counts
> and `SUM(stock_value)` matched (`RESTORE DRILL PASSED`).

**Targets:** RPO ≤ 1h (hourly dumps) or ≤ 5 min (WAL archiving); RTO ≤ 1h (documented restore runbook).

## TLS reverse proxy

`proxy/nginx-umms.conf` terminates HTTPS and forwards to the app (127.0.0.1:4000):
HTTP→HTTPS redirect, TLS 1.2/1.3 modern ciphers, OCSP stapling, HSTS + CSP + `X‑Frame‑Options: DENY`
+ `nosniff`, a login rate‑limit, and `X‑Forwarded‑Proto` so the app keeps cookies `Secure`.

```bash
sudo certbot certonly --webroot -w /var/www/certbot -d umms.example.com   # or an internal CA
sudo cp ops/proxy/nginx-umms.conf /etc/nginx/conf.d/umms.conf
sudo nginx -t && sudo systemctl reload nginx
```
App side: `NODE_ENV=production` (Secure cookies, per `reference/auth-module`) and
`app.set('trust proxy', 1)` so `req.secure`/rate‑limit see the real client IP.

## Secrets
No secrets in the repo or in a committed `.env`. Load DB creds / session keys from the OS secret
store or a vault at boot; rotate anything that ever lived in code (incl. the legacy `E&CWorkshop`).
