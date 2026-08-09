---
name: next-milestone
description: Pick up and ship the next unchecked milestone from ROADMAP.md for the Codebase Cognitive Memory project (cuonghuunguyen/claude-notebook) — implements it, runs its tests for real against Postgres, opens a PR, and subscribes to that PR's activity so CI failures and review comments come back automatically. Use whenever asked to continue building this project, or when this repo's milestone-runner Routine fires.
---

# next-milestone

This is the actual protocol — not a summary of it. Follow it in order. If
you were sent here with no prior conversation context (e.g. a Routine
firing into a fresh session), this file is your task description.

## Context you need first

- `spec.md` — the design contract. Every non-obvious decision in the
  codebase traces back to a section here.
- `ROADMAP.md` — the milestone list with acceptance criteria. Its checklist
  at the top is the only source of truth for "what's done" — more reliable
  than this skill's own memory of past runs.
- `CLAUDE.md` — the standing non-negotiables (stack, one-milestone-per-run,
  never fake a passing test).

## Steps

1. **Sync.** `git fetch origin claude/codebase-cognitive-memory-spec-t7nnx0`
   and make sure your checkout is current before reading ROADMAP.md.
2. **Find the work.** Open `ROADMAP.md`, take the first `- [ ]` milestone in
   the status checklist. If every box is checked, stop and say so — there
   is nothing to do.
3. **Concurrency guard.** List open pull requests against
   `claude/codebase-cognitive-memory-spec-t7nnx0` (`mcp__github__list_pull_requests`
   or `search_pull_requests`). If one already has a head branch named
   `milestone/M<N>-*` for the SAME milestone number you picked in step 2,
   STOP — another run is already shipping it. Don't open a second PR for
   the same milestone.
4. **Branch.** Create `milestone/M<N>-<short-slug>` from the latest
   `claude/codebase-cognitive-memory-spec-t7nnx0`.
5. **Environment.** `DATABASE_URL` should already be set by the
   SessionStart hook (`.claude/hooks/session-start.sh`). If it isn't
   (e.g. you're running outside the hook), run `bash scripts/setup-dev-db.sh`
   and export it yourself.
6. **Implement.** Build *only* the milestone from step 2, to its
   ROADMAP.md acceptance criteria. Do not start the next milestone even if
   you finish early — one milestone per PR is what keeps this reviewable.
7. **Test for real.** Unit tests unconditionally. Integration tests with
   `DATABASE_URL` set — they self-skip without it; if yours skip when they
   shouldn't, your env is misconfigured, fix that before continuing. Never
   check a box on a skipped or failing test.
8. **Update ROADMAP.md.** Check this milestone's box on your branch.
9. **Commit and push** the branch (`git push -u origin milestone/M<N>-...`).
10. **Open a PR** into `claude/codebase-cognitive-memory-spec-t7nnx0` via
    `mcp__github__create_pull_request`. Describe what was built and how it
    was verified (real Postgres, which tests, etc.) — enough that a human
    skimming the PR doesn't need this skill's context to review it.
11. **Subscribe.** Call `subscribe_pr_activity` for the PR you just opened.
    This is what makes CI failures and review comments come back
    automatically later — don't skip it.
12. **Stop.** Don't merge your own PR, don't start milestone N+1. Report
    which milestone shipped and what's next.

## If a subscribed PR gets a CI failure or review comment later

Standard PR-ownership rules apply (see the main system instructions on
handling `<github-webhook-activity>` events): diagnose and push a fix, or
reply explaining why not — never leave a CI failure on your own PR
unaddressed. Re-run the milestone's real tests before pushing a fix, same as
step 7 above.

## Non-negotiables

- Stack is locked (pnpm + TS workspaces, Postgres+pgvector+pg_trgm,
  ts-morph). Flag a needed deviation in the PR description; don't switch
  silently.
- `spec.md`'s already-decided semantics (§3.2 identity, §3.3
  confidence/weight, §7 promotion thresholds, §10 traversal batching) are
  final. Extend, don't relitigate.
- If you hit a genuine ambiguity spec.md doesn't resolve, make the smallest
  reasonable call, note it as `Deviation:` in the PR description, and keep
  going rather than stalling.
