# E2E real-world benchmark

Answers one question the unit/eval suites can't: **does this memory system
actually help on a real codebase it has never seen?** The target is
[zod](https://github.com/colinhacks/zod) v4 (`packages/zod/src/v4/{classic,core}`,
29 files / ~42k LOC of production TypeScript) — a codebase none of this
repo's fixtures were written against.

## What it measures

1. **Ingest** (`bench:ingest`): full real pipeline — ts-morph structural
   extraction → Postgres persist (event log included) → embedding indexing.
   Reports node/edge counts and wall-clock timings.
2. **Retrieval quality** (`bench:run`): 12 hand-labeled developer questions
   (`src/tasks.ts`). For each, `runPipeline(question)` → the files the
   returned `AgentContext` points at, scored as recall@10 / MRR / hit@1
   against ground truth, next to a naive keyword-grep baseline over the same
   files. `BENCH_REASONER=claude` swaps the score-threshold traversal
   reasoner for a real `claude -p` LLM reasoner (one call per depth level,
   as spec.md §10 intends).
3. **Agent usefulness** (`bench:agent`): the end-to-end question — the same
   headless `claude` agent, same model, same tools, answering the same
   questions in the zod repo **with vs without** the rendered `AgentContext`
   in its prompt. Scores whether the answer names the ground-truth files and
   symbols, plus turns/duration/cost per the CLI's JSON output.

## Running it

```bash
git clone --depth 1 https://github.com/colinhacks/zod.git /tmp/zod
export ZOD_DIR=/tmp/zod
export DATABASE_URL="postgres://postgres:postgres@localhost:5432/cognitive_memory"

pnpm --filter @cognitive-memory/eval-e2e-benchmark build
pnpm --filter @cognitive-memory/eval-e2e-benchmark bench:ingest
pnpm --filter @cognitive-memory/eval-e2e-benchmark bench:run
BENCH_REASONER=claude pnpm --filter @cognitive-memory/eval-e2e-benchmark bench:run
pnpm --filter @cognitive-memory/eval-e2e-benchmark bench:agent   # needs `claude` CLI
```

Results land in `results/` as JSON (committed for the runs that produced
`E2E_BENCHMARK_REPORT.md` at the repo root — see that report for the
findings and honest limitations, e.g. the fake hash embedder standing in
for a real embedding API, and the two synthetic episodic experiences seeded
during ingest).
