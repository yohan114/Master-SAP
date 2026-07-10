#!/usr/bin/env bash
# renew-cert.sh — renew the Let's Encrypt cert with NO downtime (webroot via the running nginx),
# refresh the copies nginx serves, and reload it. Safe to run daily from cron; certbot only acts
# when the cert is within its renewal window.
#   bash deploy/renew-cert.sh your.domain
set -euo pipefail
DOMAIN="${1:?usage: renew-cert.sh your.domain}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY="$REPO_ROOT/deploy"

# HTTP-01 challenge is served from the certbot-webroot mount by the nginx container (no stop needed).
certbot certonly --webroot -w "$DEPLOY/certbot-webroot" --non-interactive --keep-until-expiring -d "$DOMAIN"

# Refresh the pem copies nginx reads, then hot-reload nginx.
cp "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" "$DEPLOY/certs/fullchain.pem"
cp "/etc/letsencrypt/live/${DOMAIN}/privkey.pem"   "$DEPLOY/certs/privkey.pem"
( cd "$REPO_ROOT" && docker compose -f deploy/docker-compose.yml exec -T nginx nginx -s reload ) || \
  ( cd "$REPO_ROOT" && docker compose -f deploy/docker-compose.yml restart nginx )
echo "renewed + reloaded for $DOMAIN"
