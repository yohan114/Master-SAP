#!/usr/bin/env bash
# bootstrap-vps.sh — one-shot go-live for the secured storesdb app on a fresh Ubuntu/Debian VPS.
# Installs Docker + certbot if missing, applies the security port, obtains a TLS cert, templates
# nginx with your domain, brings the stack up, seeds your DB, and verifies /health.
#
# Run as root (or with sudo), from the repo root:
#   sudo DOMAIN=umms.example.com EMAIL=you@example.com APP_DIR=/opt/umms/storesdb \
#        bash deploy/bootstrap-vps.sh
#
# Prereqs you must do FIRST:
#   • DNS: an A record for $DOMAIN pointing at this VPS's public IP (verify: dig +short $DOMAIN).
#   • Firewall: allow inbound 80 and 443.
#   • Your storesdb app already copied to $APP_DIR (server.js, db.js, inventory.db, item_tracker.html,
#     package.json). apply-port.sh will port it in place.
set -euo pipefail

DOMAIN="${DOMAIN:-}"
EMAIL="${EMAIL:-}"
APP_DIR="${APP_DIR:-/opt/umms/storesdb}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY="$REPO_ROOT/deploy"

die() { echo "!! $*" >&2; exit 1; }
[ "$(id -u)" = "0" ] || die "run as root (sudo)."
[ -n "$DOMAIN" ] || die "set DOMAIN=your.domain"
[ -n "$EMAIL" ]  || die "set EMAIL=you@domain (for Let's Encrypt)"
[ -f "$APP_DIR/server.js" ] || die "no app at APP_DIR=$APP_DIR (copy your storesdb app there first)"
command -v apt-get >/dev/null || die "this script targets Debian/Ubuntu (apt). On RHEL/Alma install docker+certbot manually, then use RUNBOOK path 2A."

echo "==> [1/8] Base packages (docker, compose plugin, certbot)"
export DEBIAN_FRONTEND=noninteractive
if ! command -v docker >/dev/null; then
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg
  install -m0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg 2>/dev/null || \
    curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi
command -v certbot >/dev/null || apt-get install -y -qq certbot
systemctl enable --now docker >/dev/null 2>&1 || true
echo "    docker $(docker --version | awk '{print $3}' | tr -d ,) ready."

echo "==> [2/8] Applying the security port to $APP_DIR (backing up inventory.db first)"
[ -f "$APP_DIR/inventory.db" ] && cp -a "$APP_DIR/inventory.db" "$APP_DIR/inventory.db.pre-golive.bak" && echo "    backed up inventory.db"
bash "$DEPLOY/apply-port.sh" "$APP_DIR" --seed

echo "==> [3/8] Templating nginx + env for $DOMAIN"
sed -i "s/umms\.example\.com/${DOMAIN}/g" "$DEPLOY/nginx/umms.conf"
[ -f "$DEPLOY/.env" ] || cp "$DEPLOY/.env.production.example" "$DEPLOY/.env"

echo "==> [4/8] Obtaining TLS certificate (Let's Encrypt, standalone on :80)"
mkdir -p "$DEPLOY/certs" "$DEPLOY/certbot-webroot"
if [ ! -s "$DEPLOY/certs/fullchain.pem" ]; then
  # port 80 must be free right now (nginx isn't up yet)
  certbot certonly --standalone --non-interactive --agree-tos -m "$EMAIL" -d "$DOMAIN"
  cp "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" "$DEPLOY/certs/fullchain.pem"
  cp "/etc/letsencrypt/live/${DOMAIN}/privkey.pem"   "$DEPLOY/certs/privkey.pem"
  echo "    cert issued for $DOMAIN."
else
  echo "    cert already present in deploy/certs — skipping issuance."
fi

echo "==> [5/8] Building + starting the stack"
( cd "$REPO_ROOT" && APP_SRC="$APP_DIR" docker compose -f deploy/docker-compose.yml up -d --build )

echo "==> [6/8] Seeding your inventory.db into the app volume (first run)"
APPID="$(cd "$REPO_ROOT" && docker compose -f deploy/docker-compose.yml ps -q app)"
if ! docker exec "$APPID" test -s /data/inventory.db 2>/dev/null; then
  docker cp "$APP_DIR/inventory.db" "$APPID":/data/inventory.db
  ( cd "$REPO_ROOT" && docker compose -f deploy/docker-compose.yml restart app )
  echo "    inventory.db loaded."
else
  echo "    /data/inventory.db already present — leaving it."
fi

echo "==> [7/8] Waiting for health"
for i in $(seq 1 20); do
  sleep 2
  if curl -fsS "https://${DOMAIN}/health" >/dev/null 2>&1; then echo "    healthy."; break; fi
  [ "$i" = 20 ] && echo "    (still not healthy — check: docker compose -f deploy/docker-compose.yml logs)"
done

echo "==> [8/8] Verifying"
echo -n "    GET /health              -> "; curl -fsS "https://${DOMAIN}/health" || true; echo
echo -n "    GET /item_tracker.html   -> "; curl -sk -o /dev/null -w '%{http_code} (302=login gate)\n' "https://${DOMAIN}/item_tracker.html"
echo -n "    GET /api/items (unauth)  -> "; curl -sk -o /dev/null -w '%{http_code} (401=protected)\n' "https://${DOMAIN}/api/items?page=1&limit=1"

cat <<DONE

============================================================
 LIVE at:  https://${DOMAIN}/login.html
------------------------------------------------------------
 DO THIS NOW:
   1. Log in and CHANGE the seeded passwords (admin/keeper/pricing).
   2. Enable MFA for admin/finance (RUNBOOK step 4).
   3. Schedule cert renewal + DB backup:
        # /etc/cron.d/umms
        0 3 * * *  root  bash ${DEPLOY}/renew-cert.sh ${DOMAIN} >/var/log/umms-renew.log 2>&1
        0 1 * * *  root  sqlite3 ${APP_DIR}/inventory.db ".backup '/backups/inventory-\$(date +\%F).db'"
============================================================
DONE
