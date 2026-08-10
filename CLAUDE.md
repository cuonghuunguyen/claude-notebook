# Codebase Cognitive Memory

A graph-based memory layer for coding agents. `spec.md` is the contract;
`ROADMAP.md` tracks milestone status (check it before doing anything — it's
the source of truth, not this file's memory of past sessions).

## Rules (non-negotiable — see AGENT_HARNESS.md for the full rationale)

- Stack is locked: pnpm + TypeScript workspaces, Postgres + pgvector +
  pg_trgm, ts-morph for TS/JS structural extraction. Don't introduce a
  different one without flagging it explicitly first. One approved
  addition: `tree-sitter` for the Python extractor (spec.md §21, ROADMAP.md
  M8) — flagged in PR #9 and signed off by a human, so `/next-milestone`
  building M8 does not need to re-flag this as a new deviation. Any
  *other* new dependency still needs the same explicit flag-and-wait this
  rule always required.
- Never check a ROADMAP.md milestone box without having actually run its
  tests in this session and seen them pass (unit always; integration tests
  need `DATABASE_URL`, set automatically by the SessionStart hook —
  `scripts/setup-dev-db.sh` if you need to set it up by hand).
- One milestone per PR/diff — never blend two milestones into one commit.
  A single automated run MAY ship several milestones back-to-back (see
  "Picking up work" below), but each still gets its own branch, PR, and
  merge decision.
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
  The same conditional-merge rule applies to self-improve cycles (below) —
  see `.claude/skills/self-improve/SKILL.md` step 14.
- Never write a `BENCHMARKS.md` row for a self-improve cycle without a real
  before/after re-measurement. A candidate that doesn't actually move the
  number isn't an improvement — go find another one or report nothing
  found, don't fabricate the row.
- A `/propose-milestone` proposal (new scope, not in `spec.md` today) may
  self-merge ONLY when its PR's "Evidence" section fills in all four points
  of `.claude/skills/propose-milestone/SKILL.md` step 5 with specifics a
  human could check — a concretely cited gap, a real demonstration of it,
  an explicit consistency check against decided `spec.md` semantics, and
  concrete acceptance criteria. Confidence that an idea is good is not
  evidence; if any point is filler rather than specific, the PR stays open
  for a human, same as a flagged deviation.
- Circuit breaker: every cycle of `/next-milestone`, `/propose-milestone`,
  or `/self-improve` appends one outcome line to `CHAIN_LOG.md`.
  `/next-milestone` step 2 reads the last 3 lines before handing off to
  `/propose-milestone` — if all 3 are empty-cycle outcomes
  (`nothing-found`/`nothing-to-propose`, nothing shipped in between), it
  stops instead of handing off. This is what bounds continuous chaining:
  without a scheduled Routine to naturally space out cycles anymore, an
  unproductive survey loop could otherwise spawn sessions indefinitely at
  zero marginal value. Never skip logging an outcome, and never spawn a
  successor past a tripped breaker just because a cycle "felt" productive.

## Picking up work

Run the `/next-milestone` skill — it finds the next unchecked milestone,
implements it, tests it for real, self-reviews and sanity-checks it, opens
a PR, subscribes to that PR's activity so CI failures and review comments
come back automatically, and merges it once green (unless it flagged a
spec deviation, in which case it waits for a human). On a clean merge it
spawns a **fresh session** to start the next milestone immediately — not
a loop in the same conversation, so context (and cost) per milestone stays
flat instead of compounding across the whole project. It stops without
spawning a successor when the roadmap is exhausted or a deviation needs a
human.

Once `ROADMAP.md` is fully checked, `/next-milestone` step 2 hands off to a
two-tier chain instead of just stopping:

1. **`/propose-milestone`** researches whether there's a genuinely new
   capability worth adding — not already decided in `spec.md` — and if it
   finds one backed by real evidence (see the non-negotiable above), adds a
   new `spec.md` section and `ROADMAP.md` milestone, merges under the
   evidence-bar rule, and spawns a fresh `/next-milestone` session to build
   it. A plausible-but-unproven idea stays open for a human instead of
   merging. See `.claude/skills/propose-milestone/SKILL.md`.
2. **`/self-improve`** — the fallback when `/propose-milestone` finds no new
   candidate this cycle. Surveys the shipped system for one measurable
   improvement (performance, correctness/robustness, or code quality — no
   fixed lane, whichever has real headroom this cycle), proves it with a
   before/after in `BENCHMARKS.md`, and merges under the same conditional
   rule. See `.claude/skills/self-improve/SKILL.md`.

There is no scheduled Routine driving this anymore — idle time between
cycles was pure waste, so both tiers now chain continuously: every
non-blocked outcome (a clean merge, or a "nothing found"/"nothing to
propose" cycle) spawns a fresh `/next-milestone` session immediately,
which re-enters this same hand-off if the roadmap is still fully checked.
The chain only stops at a genuine human-decision point — a flagged
deviation, or a `/propose-milestone` proposal whose evidence bar isn't
cleanly met — never on a timer. `ROADMAP.md` growing via
`/propose-milestone` stays a deliberate, evidenced event because of the
evidence-bar rule itself, not because of how often a cycle gets to run.

## Repo/branch

`cuonghuunguyen/claude-notebook`. Milestone work happens on branches cut
from `claude/codebase-cognitive-memory-spec-t7nnx0`, PR'd back into it.
