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

## This repo uses its own memory

`scripts/self-memory.mjs` points the system at this repository. It ingests
both halves, because the benchmarks showed one without the other is useless:

```bash
node scripts/self-memory.mjs sync              # structure + our own git history + staleness pass
node scripts/self-memory.mjs ask "why ...?"    # code files + the reasoning behind them
node scripts/self-memory.mjs scout report.json # persist a distilled scout report
node scripts/self-memory.mjs stale             # M12: re-flag what history has overtaken
node scripts/self-memory.mjs stats
```

Since M11 both halves are shipped packages, not script-local code:
`packages/capture` (`captureGitHistory` — idempotent; `recordScoutReport`) and
`packages/episodic` (`queryByMeaning` — full-text + trigram + vector, never
gated on a structural node hit). `runPipeline` surfaces by-meaning hits in
`AgentContext.experiences`, so it answers even when the structural graph has no
matching node at all.

**Writing back what you worked out.** If a task made you understand how
something here actually fits together, drop it in `.claude/scout-report.json`
before finishing (`{ task, understanding, anchors }`) — the
`.claude/hooks/scout-capture.sh` Stop hook persists it and clears the file, so
the next session retrieves it instead of re-deriving it. Store synthesized
understanding only: `packages/capture` rejects a report that is really a file
listing, because grep already answers "where is X" in one turn (spec.md §24.2.1,
measured in `E2E_BENCHMARK_MULTI_REPO.md`).

Since M12 memories also bind to **text anchors** (`{ path, symbol? }` — never
line numbers, never node ids) and staleness is git-driven: `sync` and `stale`
flag any memory whose anchored paths a *newer* commit touched, and `ask` tags it
`possibly-stale — verify before trusting` in the context it hands you. A flagged
memory is still returned — the flag is a warning, not a filter, because
`WHY_MEMORY_SPIKE.md` priced missing context in agent turns too. Repairing a
flagged memory (rather than just noticing it) is M13. Anchors are text, so all
of this works identically for SQL, YAML, docs and any language — nothing here
parses anything (`packages/staleness`).

`sync` is idempotent — it skips commits already recorded, so re-run it after
merging. It mines the **whole** repo, not just `packages/`: the commits that
recorded this project's own direction changes touch `spec.md`/`ROADMAP.md` at
the root, and a subtree-scoped mine could not see them.

Structure alone loses to grep (`E2E_BENCHMARK_MULTI_REPO.md`); the knowledge
half is what pays (`WHY_MEMORY_SPIKE.md`: 7.7 → 1.4 turns against an agent that
had full git access). Which is why `ask` retrieves experiences by their own
content rather than through a node-id hit — re-measured through the shipped
package path in M11 at MRR 0.85 (0.90 with the stub embedder) against 0.00 for
the node-gated path on the same corpus (`BENCHMARKS.md`, which also records the
controls that rule out this PR's own changes as the cause of that 0.13 → 0.00).

## Quality gate (catch it in the task that caused it)

Two hooks, wired in `.claude/settings.json`:

- **`.claude/hooks/quick-typecheck.sh`** (PostToolUse on Edit/Write) —
  typechecks just the package the edited file belongs to and reports through
  `additionalContext`. Deliberately non-blocking: mid-refactor an intermediate
  state is legitimately broken.
- **`.claude/hooks/quality-gate.sh`** (Stop) — when a task finishes, runs
  typecheck + lint + tests for the packages that changed, appends a row to
  `QUALITY_LOG.md`, and records the outcome into the memory graph bound to the
  changed files. On failure it exits 2 so the errors come back to the agent
  before the task is called done; `stop_hook_active` stops it blocking twice.

Both no-op when no `.ts` file changed. The Stop gate takes ~11s on a passing
tree. A failing row in `QUALITY_LOG.md` means the problem was caught at the end
of the task that caused it rather than at the next milestone's CI run.

## Repo/branch

`cuonghuunguyen/claude-notebook`. Milestone work happens on branches cut
from `master`, PR'd back into it.
