#!/usr/bin/env bash
# Sets up a local Postgres instance for this project. This is the ONE
# verified working path in the sandboxed dev environment used to build this
# repo, where no Docker daemon is available (docker-compose.yml, if you add
# one later, is for contributors who DO have Docker — this script is the
# fallback/primary path, not a last resort).
#
# Idempotent: safe to re-run.
set -euo pipefail

DB_MAIN="cognitive_memory"
DB_TEST="cognitive_memory_test"
PG_PASSWORD="postgres"

if ! command -v psql >/dev/null 2>&1; then
  echo "Installing postgresql-16..."
  apt-get update -qq
  apt-get install -y -qq postgresql-16
fi

if ! dpkg -l 2>/dev/null | grep -q postgresql-16-pgvector; then
  echo "Installing postgresql-16-pgvector..."
  apt-get update -qq
  apt-get install -y -qq postgresql-16-pgvector
fi

if ! pg_lsclusters 2>/dev/null | grep -q "online"; then
  echo "Starting postgresql cluster..."
  pg_ctlcluster 16 main start
  sleep 1
fi

sudo -u postgres psql -c "ALTER USER postgres PASSWORD '${PG_PASSWORD}';" >/dev/null
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname = '${DB_MAIN}'" | grep -q 1 \
  || sudo -u postgres psql -c "CREATE DATABASE ${DB_MAIN};" >/dev/null
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname = '${DB_TEST}'" | grep -q 1 \
  || sudo -u postgres psql -c "CREATE DATABASE ${DB_TEST};" >/dev/null

echo ""
echo "Postgres ready. Export these before running migrations/tests:"
echo ""
echo "  export DATABASE_URL=\"postgres://postgres:${PG_PASSWORD}@localhost:5432/${DB_MAIN}\""
echo "  # for tests, use ${DB_TEST} instead:"
echo "  export DATABASE_URL=\"postgres://postgres:${PG_PASSWORD}@localhost:5432/${DB_TEST}\""
