#!/bin/bash
set -euo pipefail

cd "$CLAUDE_PROJECT_DIR"

pnpm install

# There is no database to provision any more (spec.md §25). The store is a
# single SQLite file, `.claude/memory.db` by default, created on first write by
# `graph-store`'s own connection setup — so this hook no longer resolves a
# connection string and no longer exports one.
#
# Worth recording what that removal fixed, because the bug was real and cost
# this project most of its scout-report corpus. This hook used to hardcode
#
#   postgres://postgres:postgres@localhost:5432/cognitive_memory
#
# which on a machine where 5432 belonged to an unrelated Postgres resolved to a
# server with no `cognitive_memory` database and no pgvector. Every scout-report
# write (the Stop hook) then failed authentication while `self-memory.mjs sync`
# — run by hand with a correct URL — kept working, so the corpus filled with
# commit-derived rows and almost no synthesized understanding, which is the half
# the benchmarks say actually pays (WHY_MEMORY_SPIKE.md: 7.7 -> 1.4 turns). The
# fix at the time was to stop keeping two copies of a connection string
# (`scripts/setup-dev-db.sh` printed the resolved one). The fix now is that
# there is no connection string to keep a copy of.
#
# `MEMORY_DB` still overrides the path if a session wants a scratch database.
