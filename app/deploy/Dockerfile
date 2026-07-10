# UMMS unified platform — application image.
# Build context is the REPO ROOT (so it can copy app/ + sql/schema.sql):
#   docker build -f app/deploy/Dockerfile -t umms-app .
FROM node:22-bookworm-slim

WORKDIR /srv/app
ENV NODE_ENV=production PORT=4000

# deps first (layer cache)
COPY app/package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# app code + the canonical schema (loaded on first boot) + entrypoint
COPY app ./
COPY sql /srv/sql
COPY app/deploy/entrypoint.sh /srv/entrypoint.sh

RUN useradd -r -u 10001 umms && chmod +x /srv/entrypoint.sh && chown -R umms:umms /srv
USER umms
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=4s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/bin/sh","/srv/entrypoint.sh"]
