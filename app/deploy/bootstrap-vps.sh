#!/usr/bin/env bash
# One-shot go-live for the UNIFIED UMMS platform (Postgres + app + nginx) on a fresh
# Ubuntu/Debian VPS. Installs Docker + certbot if missing, generates a DB password,
# issues a TLS cert, templates nginx with your domain, and brings the stack up. The app
# loads the schema and seeds itself on first boot.
#
# Run from the repo root, as root:
#   sudo DOMAIN=umms.example.com EMAIL=you@example.com bash app/deploy/bootstrap-vps.sh
#
# Prereqs: DNS A record for $DOMAIN -> this VPS; inbound 80 + 443 open.
set -euo pipefail
DOMAIN="${DOMAIN:-}"; EMAIL="${EMAIL:-}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
D="$REPO_ROOT/app/deploy"
die() { echo "!! $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root (sudo)"
[ -n "$DOMAIN" ] || die "set DOMAIN=your.domain"
[ -n "$EMAIL" ]  || die "set EMAIL=you@domain"
command -v apt-get >/dev/null || die "targets Debian/Ubuntu (apt); otherwise follow RUNBOOK.md path B"

echo "==> [1/6] Docker + certbot"
export DEBIAN_FRONTEND=noninteractive
if ! command -v docker >/dev/null; then
  apt-get update -qq && apt-get install -y -qq ca-certificates curl gnupg
  install -m0755 -d /etc/apt/keyrings
  . /etc/os-release
  curl -fsSL "https://download.docker.com/linux/${ID}/gpg" | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -qq && apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi
command -v certbot >/dev/null || apt-get install -y -qq certbot
systemctl enable --now docker >/dev/null 2>&1 || true

echo "==> [2/6] Config (.env + nginx domain)"
if [ ! -f "$D/.env" ]; then
  echo "DB_PASSWORD=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)" > "$D/.env"
  echo "    generated a random DB_PASSWORD in app/deploy/.env"
fi
sed -i "s/umms\.example\.com/${DOMAIN}/g" "$D/nginx/umms.conf"
mkdir -p "$D/certs" "$D/certbot-webroot"

echo "==> [3/6] TLS certificate (Let's Encrypt, standalone on :80)"
if [ ! -s "$D/certs/fullchain.pem" ]; then
  certbot certonly --standalone --non-interactive --agree-tos -m "$EMAIL" -d "$DOMAIN"
  cp "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" "$D/certs/fullchain.pem"
  cp "/etc/letsencrypt/live/${DOMAIN}/privkey.pem"   "$D/certs/privkey.pem"
fi

echo "==> [4/6] Build + start (Postgres + app + nginx)"
( cd "$REPO_ROOT" && docker compose -f app/deploy/docker-compose.yml --env-file app/deploy/.env up -d --build )

echo "==> [5/6] Wait for health"
for i in $(seq 1 30); do sleep 3; curl -fsS "https://${DOMAIN}/health" >/dev/null 2>&1 && { echo "    healthy"; break; }; done

echo "==> [6/6] Verify"
echo -n "    /health           "; curl -fsS "https://${DOMAIN}/health" || true; echo
echo -n "    / (login page)    "; curl -sk -o /dev/null -w '%{http_code}\n' "https://${DOMAIN}/"

cat <<DONE

============================================================
 UMMS platform LIVE:  https://${DOMAIN}/
   first login: admin / ChangeMe@Admin1  — CHANGE IT NOW.
 Load your real data (from a machine with the legacy DB files):
   STORES_DB=/path/inventory.db OIL_DB=/path/oilbook.db \\
     docker compose -f app/deploy/docker-compose.yml exec app node migrate-legacy.js
 Cert renewal cron (webroot, no downtime):
   0 3 * * * root certbot renew --webroot -w ${D}/certbot-webroot --deploy-hook \\
     "cp /etc/letsencrypt/live/${DOMAIN}/*.pem ${D}/certs/ && docker compose -f ${REPO_ROOT}/app/deploy/docker-compose.yml exec -T nginx nginx -s reload"
============================================================
DONE
