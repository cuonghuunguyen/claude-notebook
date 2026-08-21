#!/usr/bin/env bash
# Sets up the local Postgres this project needs (Postgres 16 + pgvector +
# pg_trgm) and prints the resolved connection URL.
#
# There are two working paths, and which one is right depends on the machine,
# so this script DETECTS rather than assumes. That detection is the point of
# the file: hardcoding one of them is what broke scout-report capture for most
# of this project's life (see the note at the bottom).
#
#   1. Docker (preferred when a daemon is reachable). Runs the official
#      `pgvector/pgvector:pg16` image, which ships the extension already
#      built — no compiler, no apt, no root on the host.
#   2. apt + pg_lsclusters. The path for a sandbox with no Docker daemon but
#      with root, which is where this repo was originally built.
#
# Idempotent either way: safe to re-run.
#
# The LAST line of stdout is always `RESOLVED_DATABASE_URL=<url>`, which is the
# contract `.claude/hooks/session-start.sh` consumes. Keep it last, and keep it
# the only line with that prefix.
set -euo pipefail

DB_MAIN="cognitive_memory"
DB_TEST="cognitive_memory_test"
PG_PASSWORD="postgres"

# Docker publishes on 5433 deliberately: a developer machine very often already
# has something on 5432, and silently sharing a port with an unrelated Postgres
# is exactly the failure this script exists to prevent.
DOCKER_CONTAINER="cognitive-memory-pg"
DOCKER_IMAGE="pgvector/pgvector:pg16"
DOCKER_PORT="5433"
APT_PORT="5432"

log() { echo "$@" >&2; }

# --- path 1: Docker ----------------------------------------------------------

setup_docker() {
  if ! docker inspect "$DOCKER_CONTAINER" >/dev/null 2>&1; then
    log "Creating container ${DOCKER_CONTAINER} (${DOCKER_IMAGE}) on port ${DOCKER_PORT}..."
    docker run -d \
      --name "$DOCKER_CONTAINER" \
      -e "POSTGRES_PASSWORD=${PG_PASSWORD}" \
      -p "${DOCKER_PORT}:5432" \
      --restart unless-stopped \
      "$DOCKER_IMAGE" >/dev/null
  elif [ "$(docker inspect -f '{{.State.Running}}' "$DOCKER_CONTAINER" 2>/dev/null)" != "true" ]; then
    log "Starting existing container ${DOCKER_CONTAINER}..."
    docker start "$DOCKER_CONTAINER" >/dev/null
  fi

  # A just-created container accepts TCP before it accepts queries.
  for _ in $(seq 1 30); do
    if docker exec "$DOCKER_CONTAINER" pg_isready -U postgres -q 2>/dev/null; then
      break
    fi
    sleep 1
  done
  if ! docker exec "$DOCKER_CONTAINER" pg_isready -U postgres -q 2>/dev/null; then
    log "Container ${DOCKER_CONTAINER} did not become ready in 30s."
    return 1
  fi

  for db in "$DB_MAIN" "$DB_TEST"; do
    if ! docker exec "$DOCKER_CONTAINER" psql -U postgres -tAc \
      "SELECT 1 FROM pg_database WHERE datname = '${db}'" | grep -q 1; then
      log "Creating database ${db}..."
      docker exec "$DOCKER_CONTAINER" psql -U postgres -qc "CREATE DATABASE ${db};" >/dev/null
    fi
  done

  echo "postgres://postgres:${PG_PASSWORD}@localhost:${DOCKER_PORT}/${DB_MAIN}"
}

# --- path 2: apt -------------------------------------------------------------

setup_apt() {
  if ! command -v psql >/dev/null 2>&1; then
    log "Installing postgresql-16..."
    apt-get update -qq
    apt-get install -y -qq postgresql-16
  fi

  if ! dpkg -l 2>/dev/null | grep -q postgresql-16-pgvector; then
    log "Installing postgresql-16-pgvector..."
    apt-get update -qq
    apt-get install -y -qq postgresql-16-pgvector
  fi

  if ! pg_lsclusters 2>/dev/null | grep -q "online"; then
    log "Starting postgresql cluster..."
    pg_ctlcluster 16 main start
    sleep 1
  fi

  sudo -u postgres psql -c "ALTER USER postgres PASSWORD '${PG_PASSWORD}';" >/dev/null
  for db in "$DB_MAIN" "$DB_TEST"; do
    sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname = '${db}'" | grep -q 1 \
      || sudo -u postgres psql -c "CREATE DATABASE ${db};" >/dev/null
  done

  echo "postgres://postgres:${PG_PASSWORD}@localhost:${APT_PORT}/${DB_MAIN}"
}

# --- resolve ----------------------------------------------------------------

URL=""
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  URL="$(setup_docker)" || URL=""
fi

if [ -z "$URL" ]; then
  log "Docker unavailable or failed; falling back to the apt path."
  URL="$(setup_apt)"
fi

log ""
log "Postgres ready. Main database:"
log "  export DATABASE_URL=\"${URL}\""
log "  # for tests, swap ${DB_MAIN} -> ${DB_TEST}"
log ""

# The contract line. `session-start.sh` reads this instead of hardcoding a URL:
# the old hook hardcoded port 5432/cognitive_memory, which on a machine where
# 5432 belongs to an unrelated Postgres meant every scout-report write failed
# authentication while `sync` (run by hand with a correct URL) kept working —
# so the memory corpus filled with commit history and almost no synthesized
# understanding, which is the half that actually pays off.
echo "RESOLVED_DATABASE_URL=${URL}"
