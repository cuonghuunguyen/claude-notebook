# Codebase Cognitive Memory

A graph-based memory layer for coding agents. `spec.md` is the contract;
`ROADMAP.md` tracks milestone status (check it before doing anything — it's
the source of truth, not this file's memory of past sessions).

## Rules (non-negotiable — see AGENT_HARNESS.md for the full rationale)

- Stack is locked: pnpm + TypeScript workspaces, Postgres + pgvector +
  pg_trgm, ts-morph for TS/JS structural extraction. Don't introduce a
  different one without flagging it explicitly first.
- Never check a ROADMAP.md milestone box without having actually run its
  tests in this session and seen them pass (unit always; integration tests
  need `DATABASE_URL`, set automatically by the SessionStart hook —
  `scripts/setup-dev-db.sh` if you need to set it up by hand).
- One milestone per run/PR. Don't blend milestones into one diff.
- `spec.md`'s already-made decisions (§3.2 node identity, §3.3 confidence
  vs weight, §7 promotion thresholds, §10 traversal batching) are final —
  extend them, don't relitigate them. If one genuinely blocks a milestone,
  say so in the commit/PR description instead of silently overriding it.
- Passing your own tests isn't done. Before opening a PR: run an independent
  review pass on the diff (the assertions and the implementation came from
  the same blind spots — a review pass exists to catch what they can't), and
  manually exercise one realistic scenario outside the test fixtures and
  read the actual output. Both go in the PR description. See
  `.claude/skills/next-milestone/SKILL.md` steps 8-9 for the full protocol.
- Merge is conditional, not manual-by-default: once CI is green and review
  threads are resolved, a PR with no flagged spec deviation merges itself
  (squash) — no human needed to press a button on a clean milestone. A PR
  that *did* flag a deviation stays open for a human; that's the one case
  where an automated judgment call should be seen before the next milestone
  builds on top of it. See `.claude/skills/next-milestone/SKILL.md` step 14.

## Picking up work

Run the `/next-milestone` skill — it finds the next unchecked milestone,
implements it, tests it for real, self-reviews and sanity-checks it, opens
a PR, subscribes to that PR's activity so CI failures and review comments
come back automatically, and merges it once green (unless it flagged a
spec deviation, in which case it waits for a human).

## Repo/branch

`cuonghuunguyen/claude-notebook`. Milestone work happens on branches cut
from `claude/codebase-cognitive-memory-spec-t7nnx0`, PR'd back into it.
