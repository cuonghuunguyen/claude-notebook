# E2E real-world benchmark

Answers one question the unit/eval suites can't: **does this memory system
actually help on a real codebase it has never seen?**

It runs against pluggable targets (`src/targets/`), selected with
`BENCH_TARGET`:

| key | repo | shape |
|---|---|---|
| `zod` (default) | [zod](https://github.com/colinhacks/zod) v4, `packages/zod/src/v4/{classic,core}` | 32 large TypeScript modules, ~42k LOC, sparse imports |
| `lodash` | [lodash-es](https://github.com/lodash/lodash) (`es` branch) | 644 tiny plain-JS ESM modules, ~21.5k LOC, dense import graph |

Two targets rather than one is the point: it separates properties of the
*system* from properties of *zod*.

## What it measures

1. **Ingest** (`bench:ingest`): full real pipeline — ts-morph structural
   extraction → Postgres persist (event log included) → embedding indexing.
   Reports node/edge counts and wall-clock timings.
2. **Retrieval quality** (`bench:run`): 12 hand-labeled developer questions
   per target (`src/targets/*.ts`). For each, `runPipeline(question)` → the
   files the returned `AgentContext` points at, scored as recall@10 / MRR /
   hit@1 against ground truth, next to a naive keyword-grep baseline over the
   same files. `BENCH_REASONER=claude` swaps the score-threshold traversal
   reasoner for a real `claude -p` LLM reasoner (one call per depth level, as
   spec.md §10 intends).

   The lodash question set is split into `hops: "single"` (the question names
   the function) and `hops: "multi"` (only a behaviour is described and the
   implementation is two or three indirections away), and results are
   aggregated per group — an averaged number hides which regime the system
   wins in.

   Two ranking columns are reported, and the difference matters:
   `mrr`/`hitAt1` are computed over `AgentContext.sourceFiles`, which
   `buildContext` truncates by relevance and then **sorts alphabetically for
   display** — so those two numbers measure the alphabet, not relevance, and
   exist only to document that artefact. `rankedMrr`/`rankedHitAt1` are
   computed over traversal discovery order, which is the system's actual
   relevance signal. Recall is a set-membership test and is unaffected.
3. **Agent usefulness, Q&A** (`bench:agent`): the same headless `claude`
   agent, same model, same tools, answering the same questions **with vs
   without** the rendered `AgentContext` in its prompt. Scores whether the
   answer names the ground-truth files and symbols, plus turns/duration/cost.
4. **Agent usefulness, real code changes** (`bench:patch`): the layer Q&A
   can't reach. A one-line behavioural regression is seeded into a pristine
   copy of the target (`src/patchTasks.ts`), the agent gets only the
   user-visible symptom, and the result is graded **by executing the patched
   module** — either `_.sortBy` is stable again or it isn't. Each run gets its
   own copy; the harness asserts every seed actually fails verification before
   spending an agent run on it.
5. **Cross-session accumulation** (`bench:session`): does knowledge carry from
   one session to the next? Session 1 fixes a bug with memory; a real
   `Experience` derived from that run's own output is recorded against the
   file nodes it edited; session 2 then fixes a *different* bug one hop away
   in three conditions (bare / structural memory / structural + episodic).
   The key measurement is whether the recorded experience surfaces in session
   2's context at all.

Layers 4 and 5 rewrite the absolute paths in the rendered context onto the
working copy before handing it to the agent, and assert afterwards that the
source clone was not modified (`escapedWorkingCopy`). Both exist because of a
real failure — see the report.

## Running it

```bash
git clone --depth 1 https://github.com/colinhacks/zod.git /tmp/zod
git clone --depth 1 --branch es https://github.com/lodash/lodash.git /tmp/lodash
export ZOD_DIR=/tmp/zod LODASH_DIR=/tmp/lodash
export DATABASE_URL="postgres://postgres:postgres@localhost:5432/cognitive_memory"

pnpm --filter @cognitive-memory/eval-e2e-benchmark build

export BENCH_TARGET=lodash          # or zod (the default)
pnpm --filter @cognitive-memory/eval-e2e-benchmark bench:ingest
pnpm --filter @cognitive-memory/eval-e2e-benchmark bench:run
BENCH_REASONER=claude pnpm --filter @cognitive-memory/eval-e2e-benchmark bench:run
pnpm --filter @cognitive-memory/eval-e2e-benchmark bench:agent           # needs `claude` CLI
pnpm --filter @cognitive-memory/eval-e2e-benchmark bench:patch-contexts
pnpm --filter @cognitive-memory/eval-e2e-benchmark bench:patch           # needs `claude` CLI
pnpm --filter @cognitive-memory/eval-e2e-benchmark bench:session         # needs `claude` CLI
```

Results land in `results/<target>/` as JSON. The files at the top level of
`results/` are the original single-target zod run behind
`E2E_BENCHMARK_REPORT.md` and are left in place so that report's citations
still resolve; `E2E_BENCHMARK_MULTI_REPO.md` covers the two-target run and
supersedes its ranking claims.
