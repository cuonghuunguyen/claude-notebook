#!/bin/bash
set -euo pipefail

cd "$CLAUDE_PROJECT_DIR"

pnpm install

# scripts/setup-dev-db.sh is idempotent (installs postgresql-16 +
# postgresql-16-pgvector via apt if missing, starts the cluster, creates
# both databases) — see that file for why this is the primary DB setup
# path here rather than docker-compose (no Docker daemon in this sandbox).
bash scripts/setup-dev-db.sh

echo 'export DATABASE_URL="postgres://postgres:postgres@localhost:5432/cognitive_memory"' >> "$CLAUDE_ENV_FILE"
