#!/usr/bin/env bash
# apply-port.sh — apply the UMMS security port to a copy of the real storesdb app.
# Idempotent: safe to re-run (already-applied hunks are skipped). Does NOT touch your
# production copy unless you point it there. Recommended flow: copy your app to a staging
# dir first, run this against the staging dir, verify, then deploy the staging dir.
#
# Usage:  deploy/apply-port.sh /path/to/storesdb [--seed]
#   <app_dir>   directory containing the legacy server.js + inventory.db
#   --seed      also run seed-users.js (creates sec_* tables + first users)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT_DIR="$REPO_ROOT/reference/storesdb-auth-port"
APP_DIR="${1:-}"
DO_SEED="${2:-}"

[ -n "$APP_DIR" ] || { echo "usage: $0 /path/to/storesdb [--seed]"; exit 2; }
[ -f "$APP_DIR/server.js" ] || { echo "error: $APP_DIR/server.js not found (is this the app dir?)"; exit 2; }

echo "==> Applying UMMS port to: $APP_DIR"

# 1) Drop in the auth module + login page + seeder.
mkdir -p "$APP_DIR/auth"
cp -v "$PORT_DIR"/auth/*.js "$APP_DIR/auth/"
cp -v "$PORT_DIR/seed-users.js" "$PORT_DIR/login.html" "$APP_DIR/"

# 2) Apply the server.js patch (idempotent — skip if the guard is already present).
if grep -q "require('./auth/siteGuard')" "$APP_DIR/server.js"; then
  echo "    server.js already ported (siteGuard present) — skipping patch."
else
  # --forward tolerates re-runs; fails loudly on a genuine conflict.
  patch -p0 --forward -d "$APP_DIR" < "$PORT_DIR/server.js.patch" \
    || { echo "!! patch did not apply cleanly — your server.js differs from the baseline."; \
         echo "   Apply the edits from $PORT_DIR/server.js.patch by hand, then re-run with the auth files in place."; exit 1; }
fi

# 3) Runtime deps (native argon2 is optional — the code falls back to scrypt).
echo "==> Installing runtime dependencies (cookie-parser, express-rate-limit)"
( cd "$APP_DIR" && npm install --save cookie-parser express-rate-limit >/dev/null ) && echo "    done."

# 4) Optional: create sec_* tables + seed the first users.
if [ "$DO_SEED" = "--seed" ]; then
  echo "==> Seeding roles/permissions/users (change the passwords immediately after!)"
  ( cd "$APP_DIR" && node seed-users.js )
fi

echo "==> Done. Next: set NODE_ENV=production, run node server.js (or use the Docker/systemd kit)."
