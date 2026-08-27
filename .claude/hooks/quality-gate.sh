#!/bin/bash
# Per-task quality gate (Stop hook).
#
# Runs when a task finishes, so a regression surfaces while the context that
# caused it is still on screen — not three milestones later. Measures the
# checks that are cheap and objective (typecheck, lint, tests for the packages
# actually touched), appends the result to QUALITY_LOG.md, and records it into
# this repo's own memory graph.
#
# That last part is the point of dogfooding: WHY_MEMORY_SPIKE.md measured that
# recorded reasoning is what the memory layer is actually good for, so every
# failing gate becomes a searchable "this broke, here is what it was" bound to
# the files that broke it.
#
# Exits 2 on failure, which feeds the output back to the agent. `stop_hook_active`
# guards the loop: a second consecutive Stop never blocks again.
set -uo pipefail

cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}" || exit 0

INPUT=$(cat)
LOOP_GUARD=$(printf '%s' "$INPUT" | python3 -c \
  'import json,sys
try: print("1" if json.load(sys.stdin).get("stop_hook_active") else "0")
except Exception: print("0")' 2>/dev/null || echo 0)

# Changed TypeScript, tracked or not. Nothing changed -> nothing to measure.
CHANGED=$( { git diff --name-only HEAD -- '*.ts'; git ls-files --others --exclude-standard -- '*.ts'; } 2>/dev/null | sort -u)
[ -z "$CHANGED" ] && exit 0

# packages/foo/src/x.ts -> packages/foo
PKGS=$(printf '%s\n' "$CHANGED" | awk -F/ '/^(packages|eval)\//{print $1"/"$2}' | sort -u)

run() { # run <label> <cmd...> -> sets DURATION, returns cmd status
  local label="$1"; shift
  local start=$SECONDS
  OUTPUT=$("$@" 2>&1)
  local status=$?
  DURATION=$((SECONDS - start))
  if [ $status -ne 0 ]; then
    FAILURES="${FAILURES}
### ${label} FAILED
$(printf '%s' "$OUTPUT" | tail -30)
"
  fi
  return $status
}

FAILURES=""
RESULTS=""

run "typecheck" pnpm -r --if-present typecheck
[ $? -eq 0 ] && RESULTS="${RESULTS}typecheck ✓ ${DURATION}s · " || RESULTS="${RESULTS}typecheck ✗ · "

# Lint only the changed files (root `pnpm lint` over the whole repo is 4s vs 1.3s
# here). CI still lints everything, so a rule that fires on an untouched file is
# not this hook's job.
run "lint" npx eslint $CHANGED
[ $? -eq 0 ] && RESULTS="${RESULTS}lint ✓ ${DURATION}s · " || RESULTS="${RESULTS}lint ✗ · "

# Tests only for packages that changed. There is no longer a "database
# available" condition to check: since spec.md §25 the store is a SQLite file the
# test setup creates per suite, so the integration suites always run.
for pkg in $PKGS; do
  [ -f "$pkg/package.json" ] || continue
  grep -q '"test"' "$pkg/package.json" || continue
  run "tests ($pkg)" pnpm --filter "./$pkg" test
  [ $? -eq 0 ] && RESULTS="${RESULTS}$(basename "$pkg") ✓ · " || RESULTS="${RESULTS}$(basename "$pkg") ✗ · "
done

VERDICT="pass"; [ -n "$FAILURES" ] && VERDICT="FAIL"
STAMP=$(date -u +"%Y-%m-%d %H:%M")
FILE_COUNT=$(printf '%s\n' "$CHANGED" | wc -l | tr -d ' ')

# --- log -------------------------------------------------------------------
if [ ! -f QUALITY_LOG.md ]; then
  cat > QUALITY_LOG.md <<'HEADER'
# Quality log

One row per finished task, written by `.claude/hooks/quality-gate.sh`. The
point is early detection: a failing row here means the problem was caught at
the end of the task that caused it, not at the next milestone's CI run.

| When (UTC) | Verdict | Files | Checks |
|---|---|---|---|
HEADER
fi
printf '| %s | %s | %s | %s |\n' "$STAMP" "$VERDICT" "$FILE_COUNT" "${RESULTS% · }" >> QUALITY_LOG.md

# --- record into our own memory --------------------------------------------
# Best effort: a memory write must never be the reason a task cannot finish.
if [ -f scripts/self-memory.mjs ]; then
  OBSERVATION="Quality gate ${VERDICT} after a task touching ${FILE_COUNT} TypeScript file(s). Checks: ${RESULTS% · }."
  [ -n "$FAILURES" ] && OBSERVATION="${OBSERVATION} Failures:${FAILURES}"
  printf '%s' "$INPUT" | python3 -c "
import json, subprocess, sys
files = '''$CHANGED'''.split()
payload = {
    'task': 'quality gate: ' + '$VERDICT',
    'observation': '''$OBSERVATION'''[:4000],
    'action': 'quality-gate hook',
    'result': '$VERDICT',
    'files': files,
    'confidence': 0.9,
}
subprocess.run(['node', 'scripts/self-memory.mjs', 'record', json.dumps(payload)],
               capture_output=True)
" 2>/dev/null || true
fi

# --- feed back --------------------------------------------------------------
if [ -n "$FAILURES" ] && [ "$LOOP_GUARD" != "1" ]; then
  echo "Quality gate failed for this task — fix before finishing.${FAILURES}" >&2
  echo "(Logged to QUALITY_LOG.md. This gate will not block a second time.)" >&2
  exit 2
fi

if [ -n "$FAILURES" ]; then
  printf '{"systemMessage":"Quality gate still failing — see QUALITY_LOG.md"}\n'
else
  printf '{"systemMessage":"Quality gate: %s"}\n' "${RESULTS% · }"
fi
exit 0
