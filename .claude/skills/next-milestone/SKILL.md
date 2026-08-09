---
name: next-milestone
description: Pick up and ship the next unchecked milestone from ROADMAP.md for the Codebase Cognitive Memory project (cuonghuunguyen/claude-notebook) — implements it, tests it for real against Postgres, self-reviews and sanity-checks it, opens a PR, subscribes to that PR's activity, and merges it once green. On a clean merge it spawns a fresh session to pick up the next milestone immediately (keeping each session's context — and cost — flat instead of accumulating across the whole project) rather than looping in place or waiting for the next scheduled trigger; it stops without spawning a successor if it flagged a spec deviation (a human needs to look) or the roadmap is exhausted. Use whenever asked to continue building this project, or when this repo's milestone-runner Routine fires.
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

1. **Sync.** `git fetch origin claude/codebase-cognitive-memory-spec-t7nnx0`,
   then `git checkout claude/codebase-cognitive-memory-spec-t7nnx0 && git
   reset --hard origin/claude/codebase-cognitive-memory-spec-t7nnx0` —
   fetch alone updates remote-tracking refs but not your working tree; if
   you're re-running in a persistent session that was last sitting on a
   milestone branch, skipping the checkout means `ROADMAP.md`, `CLAUDE.md`,
   and this very file could all be stale copies from whenever that branch
   was cut. Read `ROADMAP.md` and `CLAUDE.md` only after this step.
2. **Find the work.** Open `ROADMAP.md`, take the first `- [ ]` milestone in
   the status checklist. If every box is checked, stop and say so — there
   is nothing to do.
3. **Concurrency guard.** List open pull requests against
   `claude/codebase-cognitive-memory-spec-t7nnx0` (`mcp__github__list_pull_requests`
   or `search_pull_requests`). If one already has a head branch named
   `milestone/M<N>-*` for the SAME milestone number you picked in step 2:
   - If you don't recognize it (no memory of opening it — e.g. you're a
     fresh session and this is a stale/leftover PR from an earlier one),
     STOP — another run is already shipping it, don't open a second PR.
   - If it's the PR **you yourself opened earlier in this same
     conversation** (you were re-fired, or nudged, while that PR was still
     open), this is not a concurrency conflict — it's you resuming your own
     work. Skip ahead to check its CI/review status (step 14) instead of
     aborting.
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
8. **Self-review — don't grade your own homework.** Run the `code-review`
   skill against your diff (or, if unavailable, spawn a fresh review
   sub-agent with no memory of *why* you made each choice — it should judge
   the diff cold, the way a human reviewer would). The assertions in step 7
   were written by the same pass that wrote the implementation, so they
   share its blind spots; this step exists specifically to catch what that
   can't. Fix every CONFIRMED finding and re-run step 7's tests before
   moving on. Note in the PR description (step 11) that a review pass ran
   and what it found/fixed — "self-review: found and fixed X" or
   "self-review: no findings," not silence.
9. **Manual sanity check — don't just trust assertions.** Pick ONE realistic
   scenario for this milestone that isn't already one of the unit/eval
   fixtures verbatim, run it for real (a throwaway script, a REPL call,
   whatever fits), and read the actual output yourself. The goal is to
   catch "technically passes its own tests but the behavior is nonsense"
   bugs — e.g. for M2, actually run a hybrid-search query no eval case used
   verbatim and eyeball whether the ranked results make sense, not just
   that some assertion matched. Put what you ran and what you saw in the
   PR description under a "Manual sanity check" heading. If nothing
   realistic to hand-check exists yet for this milestone's slice, say so
   explicitly rather than skipping the heading.
10. **Update ROADMAP.md.** Check this milestone's box on your branch.
11. **Commit and push** the branch (`git push -u origin milestone/M<N>-...`).
12. **Open a PR** into `claude/codebase-cognitive-memory-spec-t7nnx0` via
    `mcp__github__create_pull_request`. Describe what was built, how it was
    verified (real Postgres, which tests), the self-review outcome (step 8),
    and the manual sanity check (step 9) — enough that a human skimming the
    PR doesn't need this skill's context to trust it.
13. **Subscribe, then schedule your own short check-in — don't just wait.**
    Call `subscribe_pr_activity` for the PR you just opened. This delivers
    CI **failures** and review comments back automatically — but a **green**
    CI run does not generate a webhook event (there's nothing to act on
    from GitHub's side), so nothing will wake you when CI passes. If you
    just sit idle waiting for an event, a clean PR with nothing wrong looks
    indistinguishable from an abandoned one. This repo's CI finishes in
    under 2 minutes (see recent runs on the Actions tab if you want to
    confirm) — schedule your own check-in around **3-5 minutes** out
    (`send_later` if available, or just poll `pull_request_read
    get_check_runs` directly since you're already active) rather than the
    hour-scale interval the general PR-babysitting instructions mention;
    that interval is sized for slow human-reviewed PRs, not this repo's
    fast CI. Only fall back to a longer interval if that first check finds
    CI still running.
14. **Merge, conditionally.** Once CI is green and every review thread on
    the PR is resolved (including any that arrived after you opened it —
    see the next section):
    - If your PR description's "Deviations from spec.md" section says
      "None" — merge it yourself (`mcp__github__merge_pull_request`,
      `merge_method: squash`). A clean milestone with no open judgment call
      doesn't need a human in the loop just to press a button.
    - If it lists a real deviation — do NOT merge. Leave the PR open. A
      deviation means you made a judgment call spec.md didn't resolve;
      that's exactly the case a human should see before it becomes
      load-bearing for the next milestone. Say so plainly in your final
      report.
15. **Continue or stop — by spawning a fresh session, not by looping in
    this one.** Don't go back to step 1 in this same conversation even
    after a clean merge: this conversation's context already holds this
    milestone's full implementation, review, and fix history, and looping
    in place would stack every future milestone's context on top of that,
    growing token cost per milestone instead of keeping it flat. Instead:
    - If you just merged cleanly in step 14 AND `ROADMAP.md` still has an
      unchecked box: call `mcp__Claude_Code_Remote__create_session` to
      spawn a **new** session for the next milestone — pass `source_url:
      "https://github.com/cuonghuunguyen/claude-notebook"`,
      `source_revision: "claude/codebase-cognitive-memory-spec-t7nnx0"`,
      and a `prompt` telling it to run this same `/next-milestone` skill
      (a fresh session starts with none of this one's context, so the
      prompt needs to be a complete standalone instruction, not "continue
      what you were doing"). Then STOP your own turn — you're done; the
      spawned session picks up from a clean base, and its own step 15
      spawns the one after that, and so on. This is what gets the next
      milestone started immediately without waiting for the next
      scheduled trigger, without accumulating context across milestones.
    - If `ROADMAP.md` now shows every box checked: stop, don't spawn
      anything, report the project complete.
    - If step 14 left a PR open on a flagged deviation: STOP now, full
      stop, and do NOT spawn a next session. Building on top of your own
      unreviewed judgment call is exactly the risk step 14 exists to
      avoid — a human needs to resolve the open PR before any further
      milestone starts, automated or not.
    Either way, report what happened this run: the milestone you shipped
    (merged, or left open and why) and whether you spawned a successor.

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
