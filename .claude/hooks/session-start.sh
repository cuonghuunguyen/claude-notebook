#!/bin/bash
set -euo pipefail

cd "$CLAUDE_PROJECT_DIR"

pnpm install

# scripts/setup-dev-db.sh is idempotent and DETECTS its path: it prefers the
# `pgvector/pgvector:pg16` container (published on 5433) when a Docker daemon is
# reachable, and falls back to apt + pg_lsclusters on 5432 for a sandbox with
# root but no Docker. See that file for why the detection matters.
#
# It ends by printing `RESOLVED_DATABASE_URL=<url>`, and we take the URL from
# there rather than repeating it here. That indirection is the fix for a real
# bug: this hook used to hardcode
#
#   postgres://postgres:postgres@localhost:5432/cognitive_memory
#
# which on a machine where 5432 belongs to an unrelated Postgres resolves to a
# server with no `cognitive_memory` database and no pgvector. Every scout-report
# write (the Stop hook) then failed authentication, while `self-memory.mjs sync`
# — run by hand with a correct URL — kept working. The corpus filled with
# commit-derived rows and almost no synthesized understanding, which is the half
# the benchmarks say actually pays (WHY_MEMORY_SPIKE.md: 7.7 -> 1.4 turns).
# Two copies of a connection string is how that drifted; now there is one.
SETUP_OUT="$(bash scripts/setup-dev-db.sh)" || SETUP_OUT=""
DB_URL="$(printf '%s\n' "$SETUP_OUT" | grep '^RESOLVED_DATABASE_URL=' | tail -1 | cut -d= -f2-)"

if [ -n "$DB_URL" ]; then
  echo "export DATABASE_URL=\"${DB_URL}\"" >> "$CLAUDE_ENV_FILE"
else
  # Say so rather than exporting a URL that does not answer. A wrong
  # DATABASE_URL is worse than none: with none, the capture hooks report
  # "no DATABASE_URL" and keep the prose; with a wrong one they fail at
  # connect, which reads like a broken database rather than a broken setting.
  echo "setup-dev-db.sh did not resolve a DATABASE_URL; integration tests and" >&2
  echo "memory capture will be skipped this session." >&2
fi
