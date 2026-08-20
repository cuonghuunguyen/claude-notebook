# Why-memory spike

Tests a different job from `eval/e2e-benchmark/`. That harness asks *where is
the code* — questions grep answers well. This one asks **why is the code like
this**: what the obvious implementation broke, what was reverted and why,
what a fix regressed. None of it is in the source.

See `WHY_MEMORY_SPIKE.md` at the repo root for results.

**As of M11 this is no longer a spike.** The capture layer and the by-meaning
retrieval it measured now live in `packages/capture` and `packages/episodic`;
what is left here is target-specific wiring plus the questions. Every script
below composes the shipped packages, so the numbers it reports are properties
of the product, not of this directory.

| script | what it does |
|---|---|
| `spike:capture` | Runs `packages/capture`'s `captureGitHistory` against the target: mines commits that explain themselves and records each as an `Experience` anchored to the paths it touched. Idempotent — a second run records nothing. |
| `spike:probe` | Scores retrieval alone: does the memory surface the commit that actually explains each question? Compares the pre-M11 node-gated hydration (`runPipeline` with `byMeaning: false`) against `queryByMeaning`. |
| `spike:compare` | A/B with a real agent. The baseline has full git access (`log`/`show`/`blame`/`grep`) — it can mine the same history on demand. |
| `pnpm test` | The same measurement over a self-contained fixture history, so it runs in CI with no zod clone at all. See `src/knowledge.eval.test.ts`. |

`SPIKE_EMBEDDER=fake` turns on the vector leg (the workspace's stub
feature-hashing embedder). It is off by default so the reported number is the
lexical floor — see BENCHMARKS.md for both.

```bash
export ZOD_DIR=/tmp/zod          # full clone, NOT --depth 1
export DATABASE_URL="postgres://postgres:postgres@localhost:5432/cognitive_memory"
pnpm --filter @cognitive-memory/eval-why-spike build
pnpm --filter @cognitive-memory/eval-why-spike spike:capture
pnpm --filter @cognitive-memory/eval-why-spike spike:probe
pnpm --filter @cognitive-memory/eval-why-spike spike:compare
```
