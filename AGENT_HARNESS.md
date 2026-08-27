# Agent Harness

The project ships milestones without per-step human input, and keeps growing and
improving itself after `ROADMAP.md` is exhausted. The executable protocols are
three chained skills; each spawns a fresh session for the next link on any
non-blocked outcome. No scheduled Routine paces them. The chain stops only at a
human-decision point: a flagged deviation, or a proposal whose evidence bar is
not cleanly met. This file records rationale, not protocol, and must not drift
from the three skills.

## Pieces

| Item | Role |
|---|---|
| **`CLAUDE.md`** | Always-loaded non-negotiables: locked stack, one-milestone-per-run, never fake a passing test, never fabricate a benchmark row, never self-merge new scope without a filled-in evidence bar. Apply to human-driven and automated runs alike. |
| **`.claude/skills/next-milestone/SKILL.md`** (`/next-milestone`) | Planned work: next unchecked `ROADMAP.md` milestone → implement → test for real against a real database → open PR → subscribe to that PR's activity. `ROADMAP.md` fully checked → hands off to `/propose-milestone` instead of stopping. |
| **`.claude/skills/propose-milestone/SKILL.md`** (`/propose-milestone`) | New scope: research a genuinely new capability, not already decided in `spec.md`. Evidence bar met (a concretely cited, demonstrated gap — see `CLAUDE.md`) → new `spec.md` section + `ROADMAP.md` milestone → hand the unchecked box to a fresh `/next-milestone` session. Only tier that decides what the system should become rather than how to build or polish what was decided: strictest bar of the three, and defaults to leaving the PR open for a human when the bar is not cleanly met. No candidate → falls through to `/self-improve` in the same session. |
| **`.claude/skills/self-improve/SKILL.md`** (`/self-improve`) | No new capability to propose: one measurable improvement to the shipped system (performance, correctness, or code quality; chosen fresh each cycle, not a fixed lane), proven by a real before/after, shipped as a PR the same way. Adds no new scope; makes existing behavior provably better. |
| **`BENCHMARKS.md`** | Append-only ledger written by `/self-improve`: one row per shipped cycle, exact measurement method and before/after numbers, so an improvement claim is checkable by a human and by the next cycle. |
| **`CHAIN_LOG.md`** | Append-only; one outcome line per cycle of all three skills (`shipped`, `nothing-found`, `nothing-to-propose`, `left-open`). Circuit-breaker memory: `/next-milestone` step 2 reads the last 3 lines before handing off to `/propose-milestone`, and stops chaining if all 3 are empty-cycle outcomes with nothing shipped between them. |
| **`.claude/hooks/session-start.sh`** | Runs `pnpm install`. Formerly also provisioned Postgres and exported `DATABASE_URL`; since M17 (spec.md §25) the store is a SQLite file created on first write — nothing to provision, no session can start without a working DB. |
| **PR-based delivery** | Milestones, proposals and self-improve cycles ship as PRs into `master`, not direct commits. Two properties direct pushes lack: GitHub's open-PR list is the concurrency guard (open PR with head branch `milestone/M<N>-*`, `propose/*` or `improve/*` = already taken), and `subscribe_pr_activity` turns CI failures and review comments into automatic follow-up on the same PR instead of silent drift. |
| **Continuous self-chaining** | Replaces the removed milestone-runner Routine, which fired a session every few hours to call `/next-milestone`, chaining into `/propose-milestone` then `/self-improve` as each tier ran out of work. Idle time between fires was waste: an outcome does not become more useful after a fixed interval. Each tier now spawns the next session itself, immediately, on any non-human-decision outcome. |

## Why this shape

Three design mistakes and their fixes:

1. **Harness treated as a cron job spawning sessions with a prompt.** That is
   scheduling: no persistent memory of the rules (a prompt restates everything
   every time), no automatic recovery when a shipped milestone's CI breaks later,
   no place for human review before merge. Fix, all three at once: rules →
   `CLAUDE.md` (always loaded); protocol → a skill (versioned with the code, also
   human-usable via `/next-milestone`); delivery → PRs (reviewable, wired into
   this environment's CI/review-event handling).
2. **A Routine asserting a hand-off that did not exist.** After
   `/next-milestone` had shipped every milestone, the Routine kept firing on
   schedule and asserting a hand-off to `/self-improve` — no such skill, no
   `BENCHMARKS.md`, no mention of either in this file or `CLAUDE.md` existed.
   Three consecutive backstop fires re-verified the same false premise before a
   human noticed and asked for the skill to be built. Fix: build the skill, not
   patch the Routine's prompt.
3. **The Routine still pacing cycles after every tier could self-chain.** It then
   bought only idle time: a `nothing-found` survey is no likelier to find
   something three hours later, and a merged PR needs no cool-down. Fix: delete
   the Routine; each tier's successor-spawning step (built for the clean-merge
   case) fires on every non-blocked outcome, `nothing-found` included. What stops
   the chain — a flagged deviation, an evidence bar not cleanly met — was never
   the Routine's job but a property of the skills, so removing the timer changes
   nothing about when a human must step in.

`/propose-milestone` exists for a distinct reason: once `/self-improve` was real,
the open question was whether the system may also grow its own scope, not just
optimize within it — a materially bigger grant of autonomy, so a different
default. `/self-improve` and `/next-milestone` self-merge whenever CI is green
and nothing was flagged; `/propose-milestone` inverts that: self-merge only when
its evidence bar (`CLAUDE.md`, `.claude/skills/propose-milestone/SKILL.md` step
5) is filled in with specifics a human could independently check, otherwise the
PR stays open for a human. The scope question was asked before a default was
encoded, not guessed.

Removing the Routine costs two things, accepted deliberately:

- **Rate.** Unpaced, a run of `nothing-found`/`nothing-to-propose` cycles could
  spawn sessions back-to-back at real API cost for zero shipped value, unwatched.
  `CHAIN_LOG.md` plus the circuit breaker in `/next-milestone` step 2 (3
  consecutive empty outcomes trips it) bounds the worst case at 3 wasted cycles,
  not an unbounded loop.
- **A dead-man's switch.** The old Routine doubled as a backstop that would
  eventually resume a stalled chain even if a session died mid-cycle before
  opening anything reviewable. Gone, and nothing in this repo replaces it: a
  spawned session that crashes, hangs, or never reaches a logged outcome stops
  the chain silently until a human notices and re-fires it by hand. Accepted
  tradeoff, not oversight — a periodic health check would itself be a scheduled
  trigger, which is what removing the Routine was for; a human is expected to
  glance at open PRs / `CHAIN_LOG.md`'s last entry occasionally instead of the
  harness self-monitoring for silence. Distinct from a clean circuit-breaker trip
  (3 consecutive empty cycles, no crash), which is surfaced durably via a GitHub
  issue opened by `/next-milestone` step 2 rather than left in a session
  transcript nobody reads.

## Target repo/branch

`cuonghuunguyen/claude-notebook`. Milestone branches (`milestone/M<N>-...`),
proposal branches (`propose/...`) and self-improve branches (`improve/...`) are
cut from and PR'd back into `master`.
