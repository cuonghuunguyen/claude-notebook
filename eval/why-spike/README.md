# Why-memory spike

Tests a different job from `eval/e2e-benchmark/`. That harness asks *where is
the code* — questions grep answers well. This one asks **why is the code like
this**: what the obvious implementation broke, what was reverted and why,
what a fix regressed. None of it is in the source.

See `WHY_MEMORY_SPIKE.md` at the repo root for results.

| script | what it does |
|---|---|
| `spike:capture` | Mines the target's git history for commits that explain themselves, records each as an `Experience` bound to the file nodes it touched. This is the capture layer `packages/` does not have. |
| `spike:probe` | Scores retrieval alone: does the memory surface the commit that actually explains each question? Compares the shipped node-gated hydration against matching the question to the knowledge text. |
| `spike:compare` | A/B with a real agent. The baseline has full git access (`log`/`show`/`blame`/`grep`) — it can mine the same history on demand. |

Nothing under `packages/` is modified; the spike composes the shipped
`recordExperience`, `runPipeline` and graph store as they are.

```bash
export ZOD_DIR=/tmp/zod          # full clone, NOT --depth 1
export DATABASE_URL="postgres://postgres:postgres@localhost:5432/cognitive_memory"
pnpm --filter @cognitive-memory/eval-why-spike build
pnpm --filter @cognitive-memory/eval-why-spike spike:capture
pnpm --filter @cognitive-memory/eval-why-spike spike:probe
pnpm --filter @cognitive-memory/eval-why-spike spike:compare
```
