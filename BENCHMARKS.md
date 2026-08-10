# Benchmarks

Append-only log of `.claude/skills/self-improve/SKILL.md` cycles. Each row
is one *measured* improvement — what changed, exactly how it was measured
(reproducible by a human, not just asserted), the before/after numbers, and
the PR that shipped it.

Never edit or delete a past row. If a later cycle finds a prior
"improvement" regressed or was measured wrong, add a new row noting it —
this file is a history, not a current-state snapshot.

| Date | Area | Change | Metric (how measured) | Before | After | PR |
|------|------|--------|------------------------|--------|-------|-----|
| 2026-08-10 | Correctness/robustness + performance | `extractChangedFiles` in `packages/structural` and `packages/structural-python`'s `incremental.ts` batched all of one incremental call's node deletions into a single Postgres transaction, instead of opening one connection checkout + one transaction per deleted node. Fixes a real atomicity gap (a crash mid-loop could leave a file's deletions half-applied) and removes the per-node connection overhead. | `vi.spyOn(getPool(), "connect")` around an `extractChangedFiles` call that deletes 3 functions from one file in a single incremental update; asserted call count, real Postgres (`cognitive_memory_test`). Test added to both packages' `integration.test.ts`. | 5 connect() calls (structural), scaling with deleted-node count | 3 connect() calls (structural), constant regardless of deleted-node count — same pattern verified in structural-python | [#14](https://github.com/cuonghuunguyen/claude-notebook/pull/14) |
