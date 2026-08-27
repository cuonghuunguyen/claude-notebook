# E2E benchmark — Codebase Cognitive Memory on a real project

> **Update 2026-08-16 — see `E2E_BENCHMARK_MULTI_REPO.md`.** The later run
> (2 repos: zod + lodash-es) found this report's ranking metric measures the
> wrong thing: `buildContext` sorts `sourceFiles` **alphabetically** after the
> top-K cut, so the MRR/hit@1 in §4 measure alphabetical position, not
> relevance. Remeasured over real traversal order: MRR 0.34 vs grep 0.34 —
> **tied, not "+15%"**. Recall figures and all of §3 and §5 are unaffected.

**Run date:** 2026-08-11 · **Environment:** sandbox Linux, Node 22.22, Postgres 16 + pgvector 0.6 (local) · **Code branch:** `claude/e2e-benchmark-setup-yvnqj5` (base: M9, roadmap M0–M9 complete) · **Harness:** `eval/e2e-benchmark/` · **Raw data:** `eval/e2e-benchmark/results/*.json`

## 1. Scope

Every existing test/eval in the repo runs on hand-written fixtures. This
benchmark measures what they cannot: does the memory system help on a real,
previously unseen codebase? Three layers:

1. **Ingest** — does the extraction → Postgres → embedding pipeline run on real
   code, how long does it take, how much does it capture.
2. **Retrieval quality** — on 12 realistic developer questions, does
   `runPipeline(question)` point at the file holding the answer, compared to a
   keyword-grep baseline (what an agent without memory would do).
3. **Usefulness to a real agent** — same headless `claude` agent, model, tools
   and questions in the zod repo, **with vs without** memory context: accuracy,
   turns, duration, cost.

## 2. Method

- **Target:** [zod](https://github.com/colinhacks/zod) v4 —
  `packages/zod/src/v4/{classic,core}`, 29 production TypeScript files, ~42,000
  lines. A real, widely used library unrelated to this repo's fixtures.
- **Question set:** 12 developer-style questions ("where is the email
  validation regex?", "how does z.coerce.number() work?"...), each hand-labeled
  with 1–2 ground-truth files after checking the zod source
  (`eval/e2e-benchmark/src/tasks.ts`).
- **Retrieval metrics:** recall@10, MRR, hit@1 over the `sourceFiles` list of
  the returned `AgentContext`, against a naive keyword search over the same
  file set.
- **Two traversal reasoner variants:** heuristic (score thresholds, §11, no
  LLM) and real Claude (`claude -p`, haiku, 1 call per depth level as spec §10
  specifies).
- **Agent comparison:** 6 questions × 2 conditions, `claude -p` (haiku), tools
  Read/Grep/Glob, cwd = zod repo. The `memory` condition has the rendered
  `AgentContext` injected into the prompt. Automatic grading: does the answer
  name the ground-truth file/symbol.

**Method limitations (read before trusting any number):** n=12 questions on 1
codebase, one run per configuration — enough for a trend, not for statistical
significance. The embedder is a **fake hash-embedder** (token overlap) because
the environment has no real embedding API, so the vector leg is weaker than
achievable. The 2 episodic experiences are **synthetic** seeds (marked
`[synthetic]`), present only to prove the episodic read path works e2e.

## 3. Layer 1 result — ingest on real code

| Metric | Value |
|---|---|
| Files parsed | 29 |
| Nodes / edges written to Postgres | 371 / 834 |
| Node breakdown | 29 file, 326 function, 6 class, 10 method |
| Time: extract / persist / embedding index | 2.9s / 0.9s / 2.2s (**~6.5s total**) |

The extraction → event log → embedding pipeline ran end to end on an unfamiliar
codebase, without error, fast.

The most important finding of the whole benchmark is in this layer: zod v4
defines most schemas through the `export const X = $constructor(...)` pattern
and arrow functions, and the MVP extractor (which only captures directly
declared `function`/`class`/`method`) **does not see them** — 42k lines yield
only 6 classes. What does not become a node, traversal can never reach: this is
the recall ceiling of the whole system, visible in layer 2.

## 4. Layer 2 result — retrieval quality (12 questions)

Aggregate (recall@10 / MRR / hit@1 / mean latency):

| Configuration | Recall@10 | MRR | Hit@1 | Latency | Context (chars) |
|---|---|---|---|---|---|
| **System — heuristic reasoner** | 0.79 | **0.38** | **0.25** | 31ms | 4,450 |
| **System — real Claude reasoner** | 0.79 | **0.39** | **0.25** | 34,988ms | **1,703** |
| Keyword-grep baseline | **0.83** | 0.33 | 0.08 | 3ms | — |

Per task (heuristic vs baseline):

| Task | Sys R@10 | Base R@10 | Sys MRR | Base MRR |
|---|---|---|---|---|
| email-regex | **0.00** | 1.00 | 0.00 | 1.00 |
| coerce | 1.00 | 1.00 | **1.00** | 0.20 |
| discriminated-union | 1.00 | 1.00 | 0.14 | 0.17 |
| to-json-schema | **1.00** | 0.50 | 0.20 | 0.20 |
| safe-parse | 1.00 | 1.00 | 0.33 | 0.50 |
| error-map | **0.00** | 0.50 | 0.00 | 0.50 |
| registry-meta | 1.00 | 1.00 | 0.25 | 0.17 |
| string-checks | 1.00 | 1.00 | 0.20 | 0.25 |
| iso-datetime | **1.00** | 0.50 | **1.00** | 0.13 |
| standard-schema | 0.50 | 0.50 | 0.11 | 0.13 |
| pipe-transform | 1.00 | 1.00 | 0.33 | 0.50 |
| from-json-schema | 1.00 | 1.00 | **1.00** | 0.25 |

Reading:

- **The system does not beat grep on recall** (0.79 vs 0.83). On a codebase
  with descriptive file names like zod, simple keyword grep is a strong
  baseline.
- **It wins on ranking:** MRR +15%, hit@1 3× (0.25 vs 0.08).
- **The 2/12 total failures (email-regex, error-map) share one cause:** the
  ground-truth files (`regexes.ts`, `errors.ts`, `config.ts`) contain only
  `export const`, so no node represents their content in the graph, the lexical
  seed points at other files, and traversal has no edge leading there. The
  extractor's coverage ceiling becomes the recall ceiling directly. This is not
  a retrieval bug: it searches correctly within what the graph holds.
- **The real Claude reasoner does not raise recall** (by design — it only
  decides expand/skip among what it is offered) but **cuts 62% of the noise
  from the context** (1.7k vs 4.4k chars) by skipping irrelevant branches. 21
  calls, 0 parse errors, ~20s/call: spec §10's "one LLM call per depth level"
  protocol works correctly and stably with a real LLM. The cost is 35s per
  question versus 31ms.
- Lexical retrieval (pg_trgm) on natural-language questions produces noisy
  seeds: "discriminated **union**" also matches the function `g**uid**` on
  trigram overlap. A vector leg with real embeddings would carry this better
  than the fake embedder.
- Episodic memory surfaced in the context on 6/12 tasks (the tasks touching
  `schemas.ts`/`checks.ts`, which have seeded experiences): the episodic read
  path works e2e.

## 5. Layer 3 result — real agent, with vs without memory

6 questions × 2 conditions, same model (haiku), tools and repo. The injected
context is the Claude-reasoner variant (the compact one):

| | Bare (no memory) | **Memory** | Delta |
|---|---|---|---|
| File accuracy (mean) | 0.83 | 0.83 | **equal** |
| Symbol accuracy (mean) | 1.00 | 1.00 | equal |
| Mean turns | 10.3 | **7.3** | **−29%** |
| Mean duration | 28.7s | **21.1s** | **−27%** |
| Total cost, 6 questions | $0.585 | **$0.404** | **−31%** |

Per task (turns bare → memory):

| Task | Bare | Memory | Note |
|---|---|---|---|
| registry-meta | 11 | **2** | context points straight at `registries.ts` |
| discriminated-union | 17 | **4** | 4× fewer turns |
| safe-parse | 6 | **3** | halved |
| standard-schema | 7 | **5** | small reduction |
| email-regex | 7 | 11 | **memory is counterproductive** — context points the wrong way (the task the system failed in layer 2), agent spends extra turns verifying |
| coerce | 14 | 19 | same pattern — noisy context makes the agent verify more |

Reading:

- **Final accuracy is unchanged:** an agent with tools finds the answer on this
  codebase with or without memory (zod is easy to grep). The value of memory
  here is cheaper and faster, not more accurate: −29% turns, −31% cost.
- **Clear correlation with retrieval quality:** 4 tasks with good retrieval →
  large speed-up (one task 5× fewer turns); 2 tasks with poor retrieval →
  slower than bare. Wrong memory context is a debt, not an asset — the agent
  pays extra turns to undo it.
- Implication: improving recall in the lower layer (extractor coverage)
  translates directly into cost savings at the agent layer.

## 6. Conclusion

**It works — at what it was designed to do, under stated conditions.**

Demonstrated:

1. **The whole pipeline survived real code with no modification:** clone zod,
   6.5s ingest, `runPipeline` returned a valid `AgentContext` for all 12
   questions, real-LLM traversal followed the protocol, 0 errors. For a system
   built entirely by autonomous agents over 9 milestones, this is not a given.
2. **~30% less cost/time/turns for the agent** when retrieval hits — and
   retrieval hit on 10/12 tasks. Multiplied by thousands of agent tasks per
   month, this is real value.
3. **Better ranking than grep** (hit@1 ×3), which is a memory layer's intended
   role of putting the right place first.

Not achieved:

1. **Does not beat grep on recall** on a grep-friendly codebase. Graph memory's
   real advantages (multi-step questions, large multi-repo codebases, knowledge
   accumulated across sessions) are outside the scope of this single-codebase
   benchmark.
2. **The hard ceiling is extractor coverage:** it misses `export const` arrow
   functions and the `$constructor` pattern → 2/12 tasks fail at the root. The
   most worthwhile fix in the system today.
3. **The two most "cognitive" layers are unverified:** semantic promotion has no
   real LLM-observation source, and episodic only ran with synthetic
   experiences. The system's long-term value lives in these two layers; a
   long-session benchmark is the natural next step.
4. Retrieval relies almost entirely on the lexical leg plus file names; real
   embeddings are needed to evaluate the vector leg properly.

### Recommendations, by measured impact

1. **Extend the extractor to `export const` arrow/call-expressions** (fixes the
   2/12 failures → expected recall ~0.95, and removes the 2 counterproductive
   memory cases at the agent layer).
2. **Wire a real embedding provider** (the interface exists, only the provider
   is missing) and remeasure the vector leg.
3. **Generate node `summary` text with an LLM at ingest** — embedding text is
   currently name + path only, too poor for the vector leg to be useful.
4. Use the Claude reasoner selectively: on when compact context matters (62%
   token saving on the agent side), off when latency matters (the heuristic's
   31ms already gives equal recall).

## 7. Reproducing

```bash
git clone --depth 1 https://github.com/colinhacks/zod.git /tmp/zod
export ZOD_DIR=/tmp/zod
export DATABASE_URL="postgres://postgres:postgres@localhost:5432/cognitive_memory"
bash scripts/setup-dev-db.sh && pnpm install && pnpm migrate && pnpm build

pnpm --filter @cognitive-memory/eval-e2e-benchmark bench:ingest
pnpm --filter @cognitive-memory/eval-e2e-benchmark bench:run                      # heuristic
BENCH_REASONER=claude pnpm --filter @cognitive-memory/eval-e2e-benchmark bench:run # LLM reasoner
BENCH_CONTEXTS=$PWD/eval/e2e-benchmark/results/contexts-system-claude.json \
  pnpm --filter @cognitive-memory/eval-e2e-benchmark bench:agent                   # needs claude CLI
```

Every number in this report is read from `eval/e2e-benchmark/results/`
(committed with this branch): `ingest.json`, `run-system-heuristic.json`,
`run-system-claude.json`, `contexts-*.json`, `agent-compare.json`.
