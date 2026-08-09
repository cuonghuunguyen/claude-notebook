---
name: propose-milestone
description: For the Codebase Cognitive Memory project (cuonghuunguyen/claude-notebook), once ROADMAP.md is fully checked — researches and proposes a genuinely NEW capability (not already decided in spec.md), extending spec.md with a new section and ROADMAP.md with a new milestone, then hands off to /next-milestone to build it. Self-merges the proposal ONLY when it clears a strict evidence bar (a concretely demonstrated gap, not a speculative idea); anything weaker stays open for human review. Falls through to /self-improve in the same session if this cycle's research turns up no candidate worth proposing. Never self-chains into another proposal cycle. Use when /next-milestone's own step 2/15 finds every ROADMAP.md box checked, or whenever asked to look for new capabilities directly.
---

# propose-milestone

This is the actual protocol, not a summary of it. Follow it in order. If you
were sent here with no prior conversation context, this file is your task
description.

## What this is for, and the line it must not cross

`/next-milestone` builds what `ROADMAP.md` already says to build.
`/self-improve` makes what's already built measurably better without
changing what it does. Neither one grows the system's scope — and until
this skill existed, nothing did. This is the one place in the harness where
the system is allowed to decide *what it should become next*, not just how
to build or polish what was already decided. That is real power, and it is
the reason this skill exists as its own file instead of being folded into
`/self-improve`'s survey step: proposing new scope needs a harder evidence
bar and a different default (stay open for a human) than optimizing
existing code does.

**The bar for self-merging a proposal is evidence, not confidence.** Don't
self-merge because the idea sounds good or fits the spec's spirit — self-
merge only when step 5's checklist is satisfied with specifics a human could
independently check. When in doubt, it isn't in doubt: leave the PR open.

## Context you need first

- `spec.md` — the design contract as it stands. A proposal EXTENDS this
  (adds a new `## N.` section) — it must never edit or contradict an
  existing decided section (§3.2 identity, §3.3 confidence/weight, §7
  promotion thresholds, §10 traversal batching, etc.).
- `ROADMAP.md` — confirms there's no pending milestone work to defer to
  instead, and gives the next milestone number to use.
- `BENCHMARKS.md` — read it so you don't propose, as "new," something
  `/self-improve` already measured and shipped as an optimization.
- `CLAUDE.md` / `AGENT_HARNESS.md` — standing non-negotiables and harness
  rationale; this skill is bound by the same rules the other two are.

## Steps

1. **Sync — but first check there's actually a checkout to sync.** Same
   reclaimed-container handling as `/next-milestone` step 1: clone fresh if
   there's no `.git`, otherwise `git fetch` + `git checkout` + `git reset
   --hard` against `origin/claude/codebase-cognitive-memory-spec-t7nnx0` —
   fetch alone doesn't update the working tree. Read `spec.md`,
   `ROADMAP.md`, and `BENCHMARKS.md` only after this step.
2. **Confirm this skill is actually the right call.** If `ROADMAP.md` has
   any unchecked `- [ ]` box, STOP and say so — that's `/next-milestone`'s
   job.
3. **Concurrency guard.** List open pull requests against
   `claude/codebase-cognitive-memory-spec-t7nnx0`. If one already has a head
   branch named `propose/*`, STOP — another proposal is already in flight
   (your own still-open PR from earlier in this conversation is "resume,"
   not a conflict — check its status instead of aborting).
4. **Research — this is the step that justifies self-merging later.** Spend
   real effort; a shallow pass produces a speculative idea, and speculative
   ideas don't clear step 5. Concretely:
   - Re-read `spec.md` end to end for what it explicitly does NOT cover —
     boundaries it names but leaves open (e.g. §16's "graph-DB/Elasticsearch
     split is deferred, not rejected" is exactly the shape of a real
     candidate: named, bounded, deferred pending a measured trigger).
   - Look at `eval/*` and `BENCHMARKS.md` for a *recurring* pattern the
     current design structurally can't address (not a one-off bug —
     `/self-improve` handles those) — e.g. an eval dimension spec.md's own
     §19 gestures at but never built, a class of query the retrieval/
     traversal design has no path for.
   - If web research tools are available, a small amount of external
     research on how comparable systems (agent memory / code-graph tools)
     handle a gap you've found in this codebase is legitimate evidence —
     but it supports a gap you already found in *this* system, it doesn't
     substitute for finding one.
   - Reject ideas that are really `/self-improve` candidates wearing a
     bigger hat (anything achievable without a new spec.md section belongs
     there, not here) and ideas that would contradict a decided semantic
     (extend, don't relitigate — see Non-negotiables).
   Pick at most ONE candidate. If nothing in this research clears "a
   concretely demonstrated gap, not a speculative idea," that is a
   legitimate outcome — skip to step 10's "nothing found" branch.
5. **The evidence bar.** Before writing anything, verify your candidate
   against every point below. All four are required for self-merge in step
   9; if you can't fill one in with specifics, either keep researching or
   downgrade your own expectation to "opens for human review," don't paper
   over the gap:
   1. **Concrete gap, cited.** Name the exact `spec.md` section(s) or
      codebase location(s) that show the capability is genuinely absent —
      not "would be nice," but "the current design cannot do X, and here is
      where that's visible."
   2. **Demonstrated, not asserted.** Show the gap actually manifesting —
      run the real system (or the closest real approximation: an eval case,
      a constructed query, a scripted scenario) against it and capture the
      actual inadequate output, the same way `/next-milestone` step 9 proves
      a milestone with a real run instead of trusting assertions.
   3. **Consistency checked.** State explicitly which existing spec.md
      decisions the proposal extends and confirm none of them are
      contradicted — if the check finds a contradiction, this is not a
      valid candidate; go back to step 4.
   4. **Scoped and buildable.** The new milestone has concrete, testable
      acceptance criteria in the same style as `ROADMAP.md`'s existing
      `M0`-`M7` entries — a vague aspiration doesn't clear this bar even if
      1-3 are solid.
6. **Draft the spec.md extension.** Append a new `## N.` section (next
   integer after the current highest, currently 20) in spec.md's existing
   style — declarative, with interfaces/tables where the existing sections
   use them. This is the one file this skill is allowed to extend; never
   edit an existing section's decided content.
7. **Draft the ROADMAP.md milestone.** Append `## M<N>` (next integer after
   the current highest checked milestone) in the exact style of the
   existing entries — **Goal:**, implementation bullets, **Acceptance:**
   criteria concrete enough for `/next-milestone` to build against without
   this skill's research context. Add the unchecked `- [ ] M<N> — <title>`
   row to the status checklist.
8. **Branch, commit, push.** `propose/<short-slug>` from the latest
   `claude/codebase-cognitive-memory-spec-t7nnx0`.
9. **Open a PR** into `claude/codebase-cognitive-memory-spec-t7nnx0`. The
   description MUST include, explicitly and by name, an "Evidence" section
   answering all four of step 5's points with specifics — this is what a
   human (or your own step 10 self-merge check) audits, not the idea's
   framing. Subscribe to the PR's activity, then schedule a short check-in
   (3-5 minutes; this repo's CI finishes in under 2) the same way
   `/next-milestone` step 13 does.
10. **Merge, conditionally — or report nothing found.**
    - **Evidence bar cleared, CI green, threads resolved:** merge it
      yourself (`merge_method: squash`). Re-read your own step 5 answers
      one more time before merging — if any of the four reads as filler
      rather than a specific, checkable claim, do NOT merge; downgrade to
      the next bullet instead.
    - **A real idea, but evidence is thin, or you're not confident all four
      points hold up:** leave the PR open for a human, same as
      `/next-milestone` treats a flagged spec deviation. Say plainly in
      your report which of step 5's four points is weak and why you didn't
      force it.
    - **Nothing found this cycle (step 4's legitimate outcome):** don't open
      a PR. Fall through to `.claude/skills/self-improve/SKILL.md` directly
      in this same session — there's still a cycle's worth of work to do,
      just not new-scope work. Report both outcomes (nothing new found; here's
      what self-improve did instead) together.
11. **Continue or stop.**
    - **Merged cleanly in step 10:** spawn a fresh session (same mechanism
      as `/next-milestone` step 15 — `mcp__Claude_Code_Remote__create_session`
      with `source_url`/`source_revision` pinned to this repo/branch) with a
      prompt telling it to run `/next-milestone` — `ROADMAP.md` now has your
      new milestone unchecked, and a fresh session builds it with a clean
      context rather than one full of this cycle's research framing. Then
      STOP your own turn.
    - **Left open for a human (step 10's middle case):** STOP, full stop, do
      NOT spawn anything. Building on top of your own unreviewed proposal is
      exactly the risk this branch exists to avoid.
    - **Fell through to `/self-improve` (step 10's last case):** follow that
      skill's own step 15 — it does not self-chain either, so this is where
      the cycle ends regardless of what `/self-improve` found.

## If a subscribed PR gets a CI failure or review comment later

Same drive-to-green posture as `/next-milestone`: diagnose and push a fix,
or reply explaining why not. A review comment questioning the evidence
itself is not a nitpick to route around — if a human pushes back on step
5's evidence after the fact, that's exactly the signal this bar exists to
surface; take it seriously rather than defending the merge.

## Non-negotiables

- Stack is locked (pnpm + TS workspaces, Postgres+pgvector+pg_trgm,
  ts-morph). A proposal that would require a different one isn't a
  candidate for self-merge — flag it for a human instead.
- `spec.md`'s already-decided semantics are final. This skill may only
  ADD a new section; it may never edit, weaken, or contradict an existing
  one. If a candidate requires that, it's not a new milestone, it's a
  relitigation — don't ship it, flag it.
- Never self-merge on confidence alone. Every self-merge must trace to a
  filled-in, specific answer for all four of step 5's evidence points —
  "this seems valuable" is not one of them.
