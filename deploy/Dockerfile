# UMMS — secured storesdb app image.
# Build context = your storesdb app dir AFTER running deploy/apply-port.sh against it
# (so server.js is patched and auth/ + seed-users.js + login.html are present).
#
#   deploy/apply-port.sh /path/to/storesdb
#   docker build -f deploy/Dockerfile -t umms-storesdb /path/to/storesdb
#
FROM node:22-bookworm-slim

# Build deps only for the optional native better-sqlite3 (the app falls back to the
# built-in node:sqlite if it isn't present, so this stays best-effort).
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

# Install deps first for layer caching.
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

# App source (already ported by apply-port.sh).
COPY . .

# Run as an unprivileged user; the DB lives on a mounted volume (see compose).
RUN useradd -r -u 10001 umms && mkdir -p /data && chown -R umms:umms /app /data
USER umms

ENV PORT=4000 INVENTORY_DB=/data/inventory.db
EXPOSE 4000

# Liveness probe hits the unauthenticated /health route added by the port.
HEALTHCHECK --interval=30s --timeout=4s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
