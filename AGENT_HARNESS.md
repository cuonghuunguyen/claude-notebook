# Agent Harness

This project builds itself milestone-by-milestone with no human required to
babysit each step. The actual, executable protocol lives in
**`.claude/skills/next-milestone/SKILL.md`** — run it via `/next-milestone`,
or it runs automatically when this repo's milestone-runner Routine fires a
fresh session. This file explains *why* the harness is shaped the way it is;
it is not itself the protocol, and shouldn't drift from the skill.

## The pieces, and what each one is for

- **`CLAUDE.md`** — always-loaded context: the non-negotiables (locked
  stack, one-milestone-per-run, never fake a passing test) that apply
  whether a human or an automated run is driving.
- **`.claude/skills/next-milestone/SKILL.md`** — the protocol itself: find
  the next unchecked `ROADMAP.md` milestone, implement it, test it for real
  against a real Postgres, open a PR, subscribe to that PR's activity.
- **`.claude/hooks/session-start.sh`** — runs `pnpm install` +
  `scripts/setup-dev-db.sh` and exports `DATABASE_URL` automatically, so no
  session (human or automated) starts without a working DB.
- **PR-based delivery, not direct pushes.** Milestones ship as PRs into
  `claude/codebase-cognitive-memory-spec-t7nnx0`, not direct commits to it.
  This buys two things a direct-push model doesn't: GitHub's own open-PR
  list becomes the concurrency guard (an open PR with a `milestone/M<N>-*`
  head branch means "someone's already on M\<N>"), and `subscribe_pr_activity`
  turns CI failures / review comments into automatic follow-up work on the
  same PR instead of silent drift.
- **The milestone-runner Routine** (a scheduled trigger firing a fresh
  session every few hours) is what actually calls `/next-milestone`
  unattended. It exists so milestones keep shipping between conversations,
  not just while a human is watching.

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

## Target repo/branch

`cuonghuunguyen/claude-notebook`. Milestone branches (`milestone/M<N>-...`)
are cut from and PR'd back into `claude/codebase-cognitive-memory-spec-t7nnx0`.
