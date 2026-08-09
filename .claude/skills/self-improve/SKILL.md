---
name: self-improve
description: For the Codebase Cognitive Memory project (cuonghuunguyen/claude-notebook) — surveys the built system for one measurable improvement (performance, correctness/robustness, or code quality/simplification; no fixed lane, pick whatever has the most real headroom this cycle), implements it, proves it with a real before/after in BENCHMARKS.md, self-reviews, opens a PR, and merges it once green under the same conditional-merge rule as /next-milestone. Reports "no improvement found this cycle" rather than manufacturing a change if nothing measurable turns up. Deliberately does not self-chain into another cycle — the next scheduled Routine fire starts the next one. Use when /propose-milestone's own research turns up no new-capability candidate this cycle (its usual caller), or whenever asked to run a self-improve cycle directly.
---

# self-improve

This is the actual protocol, not a summary of it. Follow it in order. If you
were sent here with no prior conversation context (e.g. a Routine firing
into a fresh session, or `/propose-milestone` falling through after finding
no new-capability candidate), this file is your task description.

## Why this exists, and how it differs from /next-milestone and /propose-milestone

`/next-milestone` has a fixed list of what to build next — `ROADMAP.md`'s
checklist. `/propose-milestone` grows that list when it finds a genuinely
new capability worth adding. This skill does neither: it makes what's
already built measurably better without changing what it does or growing
its scope — a shipped system still has slow queries, under-tested edges,
and code that accreted incidental complexity across its milestones, and
that's true whether or not `/propose-milestone` found anything new this
cycle. Like `/propose-milestone`, it has no checklist to consult, so it has
to (a) find its own candidate each cycle, and (b) prove the candidate was
actually worth doing, not just "a diff that looks like an improvement."
`BENCHMARKS.md` is the mechanism for (b): every claimed improvement gets a
real, reproducible before/after number, appended there, never edited
retroactively.

The other deliberate difference is chaining. `/next-milestone` spawns a
fresh session immediately after a clean merge, because the next milestone
is known and waiting. Here, the next candidate is *not* known until a
fresh survey finds it — chaining immediately would mean either re-surveying
with zero cool-down (this codebase doesn't change fast enough between
cycles to make that useful) or, worse, pressure to manufacture a finding
just to have something to hand the next session. Instead this skill ends
its own turn every time — found something or not — and leaves starting the
next cycle to this repo's milestone-runner Routine's own schedule.

## Context you need first

- `spec.md` — the design contract. An improvement MUST NOT contradict an
  already-decided semantic (see Non-negotiables below).
- `ROADMAP.md` — confirms there's no pending milestone work to defer to
  instead.
- `BENCHMARKS.md` — the append-only log of past cycles. Read it before
  surveying: it tells you what's already been tried, what the current
  baseline numbers are, and stops you from re-measuring (or re-"improving")
  the same thing twice.
- `CLAUDE.md` / `AGENT_HARNESS.md` — standing non-negotiables and the
  reasoning behind the harness shape; self-improve is bound by the same
  rules `/next-milestone` is.

## Steps

1. **Sync — but first check there's actually a checkout to sync.** Same
   reclaimed-container handling as `/next-milestone` step 1: if
   `git rev-parse --git-dir` fails, clone
   `https://github.com/cuonghuunguyen/claude-notebook` fresh and check out
   `claude/codebase-cognitive-memory-spec-t7nnx0`. Otherwise `git fetch
   origin claude/codebase-cognitive-memory-spec-t7nnx0`, then `git checkout
   claude/codebase-cognitive-memory-spec-t7nnx0 && git reset --hard
   origin/claude/codebase-cognitive-memory-spec-t7nnx0` — fetch alone
   doesn't update the working tree. Read `ROADMAP.md`, `BENCHMARKS.md`, and
   `CLAUDE.md` only after this step.
2. **Confirm this skill is actually the right call.** If `ROADMAP.md` has
   any unchecked `- [ ]` box, STOP and say so — that's `/next-milestone`'s
   job, not this skill's; don't build a "perf improvement" while real
   feature work is still pending.
3. **Concurrency guard.** List open pull requests against
   `claude/codebase-cognitive-memory-spec-t7nnx0`. If one already has a head
   branch named `improve/*`, STOP — another cycle is already in flight
   (recognize your own still-open PR from earlier in this same conversation
   as "resume," not "conflict," same as `/next-milestone` step 3).
4. **Survey — actually look, don't guess.** Spend real effort here; a
   shallow survey produces a shallow (or fake) improvement. Look across all
   three lanes before picking one — the point of not pre-committing to a
   lane is that the highest-value target varies cycle to cycle:
   - **Performance:** run the existing eval harnesses
     (`eval/retrieval`, `eval/traversal-cost`) or a targeted script against
     real Postgres and look for a hot path — an unindexed filter, an N+1
     query, a redundant re-fetch, an avoidable full table scan as data
     volume grows (the M4 PR's `experiences.task` index is the template for
     what this looks like).
   - **Correctness/robustness:** look for an edge case spec.md actually
     specifies but no existing test exercises — a promotion/conflict
     interaction, a staleness/GC boundary, a traversal-budget edge — and
     write a failing test that proves the gap before fixing it.
   - **Code quality/simplification:** run the `code-review` or `simplify`
     skill across a package that hasn't had one since its milestone shipped
     and land ONE real, measured cleanup (fewer allocations, removed
     duplication, a redundant round-trip collapsed) — "measured" here can be
     a benchmark number OR a concrete before/after (e.g. query count,
     LOC-with-behavior-preserved, a test that pins the fixed behavior).
   Pick exactly ONE candidate to ship this cycle — same one-change-per-PR
   discipline as `/next-milestone`'s one-milestone-per-PR. If the survey
   turns up nothing with a real, measurable win (this is a legitimate
   outcome, not a failure), skip to step 14's "nothing found" branch.
5. **Baseline measurement.** Before writing the fix, measure the current
   state with a real, reproducible method — a timed script against actual
   Postgres, a failing test, a query-count assertion, whatever fits the
   candidate. Write down exactly how you measured it; the PR description
   needs to let a human reproduce this, not just trust the number.
6. **Branch.** Create `improve/<short-slug>` from the latest
   `claude/codebase-cognitive-memory-spec-t7nnx0`.
7. **Environment.** `DATABASE_URL` should already be set by the
   SessionStart hook. If not, `bash scripts/setup-dev-db.sh` and export it.
8. **Implement.** The smallest change that gets the improvement — no
   speculative refactoring beyond what step 4's candidate needs.
9. **Re-measure, same methodology.** Run the exact same measurement from
   step 5 against the changed code. If the number didn't actually improve
   (or a robustness fix's new test doesn't actually fail on the old code /
   pass on the new one), the candidate wasn't real — revert and go back to
   step 4, don't force a BENCHMARKS.md entry to justify the branch already
   existing.
10. **Test for real.** Unit tests unconditionally; integration tests with
    `DATABASE_URL` set (never check anything off on a skipped or failing
    test). Run the full `pnpm -r test`, not just the touched package — an
    improvement that regresses an unrelated package isn't an improvement.
11. **Self-review.** Run the `code-review` skill against the diff (or a
    fresh review sub-agent with no memory of *why* you chose this change).
    Fix every CONFIRMED finding and re-run step 10's tests. Note the outcome
    in the PR description, same as `/next-milestone` step 8.
12. **Append to BENCHMARKS.md.** One row: date, area, what changed, exactly
    how it was measured, before, after, and the PR link (fill the link in
    after step 14 opens it, or reconcile with a follow-up commit on the same
    branch before merge). Never edit or delete a prior row — if a later
    cycle finds a past "improvement" regressed, add a new row noting it,
    don't rewrite history.
13. **Commit, push, open a PR** into `claude/codebase-cognitive-memory-spec-t7nnx0`.
    The PR description needs, explicitly: what was measured and how
    (reproducible by a human), the before/after numbers, the self-review
    outcome, and a "Deviations from spec.md" section (`None`, or the real
    call you made and why). Subscribe to the PR's activity
    (`subscribe_pr_activity`), then schedule your own short check-in
    (3-5 minutes — this repo's CI finishes in under 2) the same way
    `/next-milestone` step 13 does, since a green CI run alone generates no
    webhook event to wake you.
14. **Merge, conditionally — or report nothing found.**
    - **Improvement shipped:** once CI is green and every review thread is
      resolved, merge it yourself (`merge_method: squash`) if the PR's
      Deviations section says "None." If it lists a real deviation, leave
      it open for a human — same rule as `/next-milestone` step 14.
    - **Nothing found this cycle:** don't open a PR, don't force a change.
      Report plainly that this cycle surveyed and found no candidate with a
      real, measurable win, and say what you looked at so the next cycle
      doesn't have to repeat the same ground from scratch.
15. **Stop. Do not self-chain.** Unlike `/next-milestone`, do NOT spawn a
    fresh session for another cycle after merging (or after finding
    nothing) — report what happened this run and end your turn. The next
    cycle starts at this repo's milestone-runner Routine's next scheduled
    fire, which re-enters `/next-milestone` step 2, hands off to
    `/propose-milestone`, and lands back here again if that cycle also
    finds nothing new to propose. This bounded cadence is deliberate — see
    "Why this exists" above.

## If a subscribed PR gets a CI failure or review comment later

Same drive-to-green posture as `/next-milestone`: diagnose and push a fix,
or reply explaining why not. Re-run step 10's real tests before pushing any
fix.

## Non-negotiables

- Stack is locked (pnpm + TS workspaces, Postgres+pgvector+pg_trgm,
  ts-morph). An improvement that would require a different one isn't a
  self-improve candidate — flag it in a report instead of doing it.
- `spec.md`'s already-decided semantics (§3.2 identity, §3.3
  confidence/weight, §7 promotion thresholds, §10 traversal batching) are
  final. A "performance improvement" that changes one of these is a
  deviation, not a self-improvement — flag it, don't ship it silently.
- Never fabricate a BENCHMARKS.md entry. If step 9's re-measurement doesn't
  actually show the improvement, there is no improvement this cycle — go
  back to step 4 or report nothing found, don't write down a number that
  didn't happen.
