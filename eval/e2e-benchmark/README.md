# E2E real-world benchmark — RETIRED at M15 (results kept as evidence)

This harness asked one question: **does the structural graph actually help an
agent on a real codebase it has never seen?** It ingested a real repo with
`packages/structural` (ts-morph), retrieved seeds, traversed the symbol graph,
built a context, and ran a real agent against a grep-and-read baseline on
labelled tasks over `colinhacks/zod` and `lodash/lodash`.

**Its answer was no**, and that answer is why the harness no longer exists.
`E2E_BENCHMARK_MULTI_REPO.md` (and `E2E_BENCHMARK_REPORT.md` before it) records
the measurement: structure alone loses to grep on "where is the code" questions,
because grep can reconstruct code relations from the source itself. That finding
is what `spec.md` §24 was written on top of, and ROADMAP M15 is what it
eventually cost — `packages/structural`, `packages/structural-python`,
`packages/traversal`, `packages/retrieval`'s node search and `packages/semantic`
were all removed, so there is nothing left for this harness to drive.

## Why `results/` is still here

`E2E_BENCHMARK_REPORT.md` and `E2E_BENCHMARK_MULTI_REPO.md` cite these JSON
files directly — per-task hit/miss, the contexts each arm was handed, the agent
transcripts' summarised outcomes. Deleting them would leave both reports
asserting numbers with nothing behind them, which is the one thing this
repository's benchmark discipline forbids. They are frozen inputs to a written
conclusion, not a live fixture.

The question this harness asked is now asked by `eval/why-spike` instead — not
"where is the code" but "why is the code like this", which is the half the same
measurements showed grep *cannot* reconstruct (`WHY_MEMORY_SPIKE.md`,
`BENCHMARKS.md`).
