# Agent Harness

Standing protocol for any Claude Code session — this one resumed later, or a
fresh session spawned automatically by a Routine — to pick up this build
with no conversation history required. If you were sent here by a Routine
prompt, this file is your actual task description; the Routine prompt is
just a pointer to it.

## Where things are

- `spec.md` — the contract. Every design decision (node identity, the
  confidence/weight split, promotion thresholds, traversal batching, etc.)
  is already made and justified there. Extend it; don't relitigate it. If a
  milestone's own acceptance criteria seem to conflict with spec.md, spec.md
  wins — flag the conflict in your commit message instead of silently
  picking one.
- `ROADMAP.md` — the milestone list (M0-M7), each with concrete acceptance
  criteria. The checklist at the top of that file is the single source of
  truth for "what's done" — trust it over anything else, including this
  file's memory of past runs.
- `scripts/setup-dev-db.sh` — the ONE verified way to get Postgres+pgvector+
  pg_trgm running in this sandboxed environment (no Docker daemon here —
  don't try `docker compose up`, it will fail; this script is the real
  path, not a fallback).

## Protocol for one run

1. `git pull` the target branch (see below) to get the latest state — do
   not assume your checkout is current.
2. Open `ROADMAP.md`, find the first unchecked `- [ ]` milestone in the
   checklist. If all are checked, stop here and say so; there is nothing to
   do.
3. **Concurrency guard.** Run `git log --oneline -5`. If the most recent
   commit's subject is `[wip: <this milestone>] starting` and its timestamp
   (`git log -1 --format=%cI`) is less than 3 hours old, STOP immediately —
   another session is already on this milestone. Do not start a second one.
4. Push a lock marker before doing any real work:
   `git commit --allow-empty -m "[wip: M<N>] starting" && git push`.
   This is what step 3 checks for on the next run.
5. `bash scripts/setup-dev-db.sh`, then `export DATABASE_URL=...` per its
   output (use the `_test` database for running tests).
6. `pnpm install`, then implement **only** the milestone found in step 2 —
   its acceptance criteria in ROADMAP.md are the definition of done. Do not
   start the next milestone in this same run, even if you finish early:
   one milestone per run keeps every diff independently reviewable, which
   is the whole point of this harness existing instead of one big rewrite.
7. Run the milestone's tests for real: unit tests unconditionally, and
   integration tests with `DATABASE_URL` set (they self-skip without it —
   if yours skip when they should have run, your env setup is wrong, fix
   that before continuing). Never mark a milestone done on a skipped or
   failing test.
8. Check the milestone's box in `ROADMAP.md`.
9. Commit (a real message describing what was built, not `[wip: ...]` —
   that prefix is reserved for the lock marker in step 4) and
   `git push -u origin <branch>`.
10. Stop. Report what shipped and what the next unchecked milestone is.

## Non-negotiables

- Never invent a different stack than what's already committed: pnpm
  workspaces + TypeScript, Postgres + pgvector + pg_trgm, ts-morph for
  TS/JS structural extraction. If a milestone seems to need something else,
  say so in the commit message rather than switching silently.
- Never claim a milestone is done without having actually run its tests in
  this session and seen them pass.
- Provenance and confidence semantics (spec.md §3.3-§4) are load-bearing —
  don't take a shortcut that skips attaching real provenance to a node/edge
  "for now."
- If you hit a genuine ambiguity spec.md doesn't resolve, make the smallest
  reasonable call, document it in the commit message under a `Deviation:`
  line, and keep going — don't stall the whole harness waiting for a human.

## Target repo/branch

`cuonghuunguyen/claude-notebook`, branch `claude/codebase-cognitive-memory-spec-t7nnx0`.
