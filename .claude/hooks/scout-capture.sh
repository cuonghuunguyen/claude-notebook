#!/bin/bash
# Scout-report capture (Stop hook) — spec.md §24.2.1's second capture source
# class, dogfooded on this repository.
#
# A hook cannot synthesize understanding; only the agent that did the scouting
# can. So the contract is a drop box: during a task, an agent that worked out
# how something here actually fits together writes
# `.claude/scout-report.json`:
#
#   { "task": "how the by-meaning legs are fused",
#     "understanding": "…prose, not a file listing…",
#     "anchors": ["packages/episodic/src/byMeaning.ts"] }
#
# and this hook persists it at task end and clears the box, so the next
# session retrieves it instead of re-deriving it. `packages/capture` rejects a
# report that is really just file locations (spec.md §24.2.1's guardrail), which
# is why a rejection here is reported rather than swallowed.
#
# Best effort by design: a memory write must never be the reason a task cannot
# finish. No report, no database, or no build -> silent no-op.
set -uo pipefail

cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}" || exit 0

REPORT=".claude/scout-report.json"
# No report is the normal case, and the only one that stays silent.
[ -f "$REPORT" ] || exit 0

# A report that exists but cannot be persisted must SAY so. M11's acceptance
# calls this hook the dogfood producer; `dist/` is gitignored, so in a fresh
# checkout the build simply has not run yet, and exiting 0 without a word would
# make the producer look like it worked while dropping the prose on the floor.
if [ -z "${DATABASE_URL:-}" ]; then
  printf '{"systemMessage":"Scout report left at %s — no DATABASE_URL to record it into."}\n' "$REPORT"
  exit 0
fi
if [ ! -f packages/capture/dist/index.js ]; then
  printf '{"systemMessage":"Scout report left at %s — packages/capture is not built (run pnpm build)."}\n' "$REPORT"
  exit 0
fi

# Strips the double quote, the backslash, and every C0 control character
# (tabs and newlines in a stack trace included) — anything else would make this
# hook's stdout invalid JSON, which is worse than a truncated message.
sanitize() { printf '%s' "$1" | tr -d '"\\' | tr '\000-\037' ' '; }

if OUTPUT=$(node scripts/self-memory.mjs scout "$REPORT" 2>&1); then
  rm -f "$REPORT"
  printf '{"systemMessage":"Scout report recorded into memory: %s"}\n' "$(sanitize "$OUTPUT")"
else
  # Keep the file: the agent can fix the report rather than losing the prose.
  printf '{"systemMessage":"Scout report NOT recorded (left at %s): %s"}\n' \
    "$REPORT" "$(sanitize "$(printf '%s' "$OUTPUT" | tail -3)")"
fi
exit 0
