# Agent Harness

This project builds itself milestone-by-milestone with no human required to
babysit each step, and once the milestone list runs out, it keeps growing
and improving itself the same way. The actual, executable protocols live in
three skills — **`.claude/skills/next-milestone/SKILL.md`** (`/next-milestone`),
**`.claude/skills/propose-milestone/SKILL.md`** (`/propose-milestone`), and
**`.claude/skills/self-improve/SKILL.md`** (`/self-improve`) — chained so
that whichever one applies runs, and each one spawns a fresh session running
the next link in the chain immediately on any non-blocked outcome. There is
no scheduled Routine anymore; the chain restarts itself the instant a cycle
finishes, and only actually stops at a genuine human-decision point (a
flagged deviation, or a proposal whose evidence bar isn't cleanly met). This
file explains *why* the harness is shaped the way it is; it is not itself
the protocol, and shouldn't drift from any of the three skills.

## The pieces, and what each one is for

- **`CLAUDE.md`** — always-loaded context: the non-negotiables (locked
  stack, one-milestone-per-run, never fake a passing test, never fabricate
  a benchmark row, never self-merge new scope without a filled-in evidence
  bar) that apply whether a human or an automated run is driving.
- **`.claude/skills/next-milestone/SKILL.md`** — the protocol for planned
  work: find the next unchecked `ROADMAP.md` milestone, implement it, test
  it for real against a real Postgres, open a PR, subscribe to that PR's
  activity. Once `ROADMAP.md` is fully checked, hands off to
  `/propose-milestone` rather than stopping.
- **`.claude/skills/propose-milestone/SKILL.md`** — the protocol for
  growing the plan itself: research whether there's a genuinely new
  capability worth adding (not already decided in `spec.md`), and if the
  research clears a strict evidence bar (a concretely cited, demonstrated
  gap — see `CLAUDE.md`), add a new `spec.md` section and `ROADMAP.md`
  milestone and hand the newly-unchecked box to a fresh `/next-milestone`
  session. This is the one place the system is allowed to decide what it
  should become next rather than how to build or polish what was already
  decided — which is exactly why it has the strictest bar of the three
  skills and defaults to leaving a PR open for a human whenever that bar
  isn't cleanly met, rather than defaulting to merge. Falls through to
  `/self-improve` in the same session when a cycle's research finds no
  candidate.
- **`.claude/skills/self-improve/SKILL.md`** — the protocol for when there's
  no new capability to propose either: survey the shipped system for one
  measurable improvement (performance, correctness, or code quality —
  chosen fresh each cycle, not a fixed lane), prove it with a real
  before/after, open a PR the same way. Unlike the other two, it never adds
  new scope — only makes existing behavior better, provably.
- **`BENCHMARKS.md`** — the append-only ledger `/self-improve` writes to:
  one row per shipped cycle, with the exact measurement method and the
  before/after numbers, so a claimed improvement is checkable by a human
  and by the next cycle, not just asserted.
- **`CHAIN_LOG.md`** — the append-only log every cycle of all three skills
  writes one outcome line to (`shipped`, `nothing-found`,
  `nothing-to-propose`, or `left-open`). This is the circuit breaker's
  memory: `/next-milestone` step 2 reads its last 3 lines before handing
  off to `/propose-milestone`, and stops instead of chaining further if all
  3 are empty-cycle outcomes with nothing shipped between them.
- **`.claude/hooks/session-start.sh`** — runs `pnpm install` +
  `scripts/setup-dev-db.sh` and exports `DATABASE_URL` automatically, so no
  session (human or automated) starts without a working DB.
- **PR-based delivery, not direct pushes.** Milestones, proposals, and
  self-improve cycles all ship as PRs into
  `master`, not direct commits to it.
  This buys two things a direct-push model doesn't: GitHub's own open-PR
  list becomes the concurrency guard (an open PR with a `milestone/M<N>-*`,
  `propose/*`, or `improve/*` head branch means "someone's already on
  this"), and `subscribe_pr_activity` turns CI failures / review comments
  into automatic follow-up work on the same PR instead of silent drift.
- **Continuous self-chaining, not a scheduled Routine.** A milestone-runner
  Routine used to fire a fresh session every few hours to call
  `/next-milestone`, which chained into `/propose-milestone` and then
  `/self-improve` as each tier ran out of its own kind of work. That Routine
  was removed: idle time between fires was pure waste, since a cycle's
  outcome doesn't get more useful by waiting a fixed interval before the
  next one runs. Now every tier spawns the next session itself, immediately,
  on any outcome that isn't a genuine human-decision point — see "Why this
  shape" below for why that boundary (not a timer) is what should gate the
  chain.

## Why this shape

The original design mistake here was treating "harness" as "a cron job that
spawns sessions with a prompt." That's scheduling, not a harness — it has no
persistent memory of the rules (a prompt has to re-state everything every
time), no automatic recovery when a shipped milestone's CI breaks later, and
no natural place for a human to review before merge. Moving the actual rules
into `CLAUDE.md` (always loaded), the actual protocol into a skill (versioned
with the code, reusable via `/next-milestone` by a human too), and delivery
into PRs (reviewable, and wired into this environment's own CI/review-event
handling) fixes all three at once.

The second design mistake, caught only after `/next-milestone` had already
shipped every milestone: a Routine kept firing on schedule and asserting
that a hand-off to `/self-improve` existed, when in fact no such skill,
no `BENCHMARKS.md`, and no mention of either in this file or `CLAUDE.md`
had ever been created — three consecutive backstop fires re-verified the
same false premise before a human noticed the actual mismatch and asked for
the skill to be built for real.

`/propose-milestone` exists for a related but distinct reason: once
`/self-improve` was real, the natural next question was whether the system
should also be allowed to grow its own scope, not just optimize within it.
That is a materially bigger grant of autonomy than "optimize what's already
decided," so it doesn't get the same default. `/self-improve` and
`/next-milestone` both self-merge whenever CI is green and nothing was
flagged; `/propose-milestone` inverts that default — it only self-merges
when its evidence bar (`CLAUDE.md`, `.claude/skills/propose-milestone/SKILL.md`
step 5) is filled in with specifics a human could independently check, and
stays open for a human otherwise. The fix for a missing skill was to build
the skill, not patch the Routine's prompt; the fix for "should the system
expand its own scope" was to ask before encoding a default, not to guess one.

A third design mistake, caught after both fixes above: the milestone-runner
Routine itself was still the thing restarting each cycle, on a fixed
multi-hour cadence, even once `/self-improve` and `/propose-milestone` were
real and every tier already knew how to spawn its own successor on a clean
outcome. The Routine wasn't buying anything at that point except idle time
between cycles — a "nothing found" survey isn't more likely to find
something three hours later just because time passed, and a merged PR
doesn't benefit from a cool-down before the next cycle starts. The fix was
to delete the Routine and let every tier's own successor-spawning step
(already built for the "clean merge" case) fire on every non-blocked
outcome, "nothing found" included. What still stops the chain — a flagged
deviation, an evidence bar that isn't cleanly met — was never the Routine's
job to enforce anyway; it was always a property of the skills themselves,
so removing the timer changes nothing about when a human actually needs to
step in.

Removing the Routine costs two things, taken on deliberately rather than
missed:

- **Rate.** Once nothing paces the chain, a run of unproductive
  `nothing-found`/`nothing-to-propose` cycles could spawn sessions
  back-to-back at real API cost for zero shipped value, with no one
  watching. `CHAIN_LOG.md` plus the circuit breaker in `/next-milestone`
  step 2 (3 consecutive empty outcomes trips it) bounds this: worst case is
  3 wasted cycles, not an unbounded loop.
- **A dead-man's switch.** The old Routine doubled as a backstop that would
  eventually resume a stalled chain even if a session died mid-cycle before
  opening anything reviewable — that's genuinely gone, and nothing in this
  repo replaces it. If a spawned session crashes, hangs, or otherwise never
  reaches a logged outcome, the chain silently stops and stays stopped until
  a human notices and re-fires it by hand. This is an accepted tradeoff, not
  an oversight: a periodic health-check would itself be a scheduled trigger,
  which is exactly what removing the Routine was for. A human is expected to
  glance at open PRs / `CHAIN_LOG.md`'s last entry occasionally rather than
  the harness self-monitoring for silence. This is distinct from a *clean*
  circuit-breaker trip (3 consecutive empty cycles, no crash) — that case
  IS surfaced durably, via a GitHub issue `/next-milestone` step 2 opens,
  rather than left to a session transcript nobody reads.

## Target repo/branch

`cuonghuunguyen/claude-notebook`. Milestone branches (`milestone/M<N>-...`),
proposal branches (`propose/...`), and self-improve branches (`improve/...`)
are all cut from and PR'd back into
`master`.
