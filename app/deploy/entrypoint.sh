#!/bin/sh
# Container entrypoint: load the schema on first boot, seed ONLY when the DB is fresh
# (never re-seed an existing DB — that would reset the admin password), then run the app.
set -u
cd /srv/app

# wait for PostgreSQL to accept connections
i=0
until node -e "const{pool}=require('./db');pool.query('SELECT 1').then(()=>process.exit(0)).catch(()=>process.exit(1))" 2>/dev/null; do
  i=$((i+1)); [ "$i" -ge 60 ] && { echo "database not reachable after 60 tries"; exit 1; }
  echo "waiting for database…"; sleep 2
done

node init-db.js; code=$?
if [ "$code" = "10" ]; then
  echo "fresh database — seeding base roles/users/masters"
  node seed.js || { echo "seed failed"; exit 1; }
elif [ "$code" != "0" ]; then
  echo "init-db failed (exit $code)"; exit 1
fi

exec node server.js
