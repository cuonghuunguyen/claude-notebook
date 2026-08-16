# E2E benchmark, second repo: does it hold up outside zod?

**Run date:** 2026-08-16 · **Environment:** sandbox Linux, Node 22.22, Postgres 16 + pgvector · **Code branch:** `claude/github-repo-benchmark-61eabd` (base: M9 + PR #17) · **Harness:** `eval/e2e-benchmark/` · **Raw data:** `eval/e2e-benchmark/results/{zod,lodash}/*.json`

## 1. Why this run exists

`E2E_BENCHMARK_REPORT.md` (PR #17) benchmarked one codebase, zod, with one
kind of question ("where is X implemented?"). Two things were left open, and
both matter more than the numbers it produced:

1. **Was any of it a property of zod?** One repo cannot tell you.
2. **Does it help with *work*, or only with *lookup*?** Answering "which file
   holds the email regex" is the task grep is best at. Real agent work is
   changing code, and that was never measured.

This run adds a second target with the opposite shape, adds two layers that
make an agent actually modify code, and re-runs zod as a control.

**Targets**

| | zod v4 (control) | lodash-es (new) |
|---|---|---|
| Source | `github.com/colinhacks/zod`, `packages/zod/src/v4/{classic,core}` | `github.com/lodash/lodash` branch `es`, commit `d85490e` |
| Shape | 32 large TypeScript modules, ~42k LOC | 644 tiny plain-JS ESM modules, ~21.5k LOC |
| Idiom | `export const X = $constructor(...)` | `function x() {}` + `export default x` |
| Import graph | sparse (95 edges) | dense (1652 edges) |

They were chosen to disagree with each other on every axis the extractor
cares about.

## 2. Findings, in order of how much they should change what gets built next

### Finding 1 — the extractor crashes on plain JavaScript

Pointing the shipped extraction path at lodash throws inside the TypeScript
checker before producing a single node:

```
TypeError: Cannot read properties of undefined (reading 'escapedName')
  at getSignatureFromDeclaration (typescript.js:62667)
  at FunctionDeclaration.getReturnType (ts-morph.js:9872)
  at shapeFingerprint (packages/structural/dist/shape.js:21)
  at extractProject (packages/structural/dist/extract.js:71)
```

`shapeFingerprint` asks for a declaration's return type; for a `function` in a
`.js` file the checker has no symbol unless `allowJs` is set, and
`loadProject()` exposes no way to set it (`rootDir` and an optional tsconfig
path are the only inputs). So **a JavaScript repository cannot be ingested
through the package's own API at all** — the benchmark had to construct its
own ts-morph `Project` to proceed.

This is the single highest-value fix in the system right now: it is small,
and it is the difference between "supports TS/JS" and "supports TS".

### Finding 2 — the ranking claim in the previous report doesn't survive a correct metric

`buildContext` truncates `sourceFiles` by relevance and then **sorts the
survivors alphabetically for display** (`packages/context/src/build.ts`, and
the code says so deliberately). The previous benchmark computed MRR and hit@1
over that list — so it was measuring alphabetical position, not relevance.

Recomputing ranking over traversal discovery order (the system's real
relevance signal) changes the conclusion:

| zod, heuristic reasoner | previous report | measured over display order | measured over relevance order |
|---|---|---|---|
| MRR | 0.38 (claimed +15% vs grep) | 0.44 | **0.34** |
| hit@1 | 0.25 (claimed 3× grep) | 0.25 | **0.17** |
| grep baseline MRR / hit@1 | 0.33 / 0.08 | 0.34 / 0.08 | 0.34 / 0.08 |

Against grep, the system is **tied on MRR (0.34 vs 0.34) and roughly level on
hit@1**, not ahead. "It ranks better than grep" was an artefact of file names
that happened to sort early. Recall figures in the old report are unaffected —
recall is set membership, and the set is still chosen by relevance.

On lodash the same correction makes the gap worse, not better (below).

### Finding 3 — on a repo it wasn't tuned against, retrieval loses to grep in every regime

12 hand-labeled questions per repo, recall@10 over the returned context, MRR
over relevance order, against a naive keyword-grep baseline on the same files:

| | system recall@10 | grep recall@10 | system MRR | grep MRR |
|---|---|---|---|---|
| **zod** (heuristic) | 0.75 | **0.83** | 0.34 | 0.34 |
| **zod** (Claude reasoner) | 0.75 | **0.83** | 0.27 | 0.34 |
| **lodash** (heuristic) | 0.46 | **0.67** | 0.20 | **0.53** |
| **lodash** (Claude reasoner) | 0.42 | **0.67** | 0.13 | **0.53** |

The lodash question set was deliberately split in half when it was written, to
find the regime where a graph should beat a keyword search:

| lodash | system recall | grep recall | system MRR | grep MRR |
|---|---|---|---|---|
| **single-hop** (question names the function) | 0.60 | **1.00** | 0.25 | **0.85** |
| **multi-hop** (behaviour only; answer is 2–3 indirections away) | 0.36 | **0.43** | 0.16 | **0.30** |

Single-hop losing to grep is expected and uninteresting: lodash is one
function per file, so the filename *is* the answer and grep is perfect by
construction. **The result that matters is multi-hop** — the regime graph
memory exists for, where grep is weak (0.43) and the system is weaker (0.36).

Reading the per-task detail shows why: lexical seeds are noisy on natural
language, and the traversal then wanders. "What stops deduplicating a very
large array from degrading into a quadratic scan?" returns `fromPairs.js`,
`_baseAssignValue.js`, `_copyArray.js` — never `_baseUniq.js`. Three separate
questions all surface `max.js` / `_baseExtremum.js` as their top hits. Two
questions are answered essentially perfectly (`memoize-cache` and `deep-equal`
both rank the right internal file first), so the machinery *can* work; it just
doesn't reliably.

The 42%-vs-46% difference between reasoner variants is inside run-to-run
noise (repeated heuristic runs moved recall by ±0.04 on their own).

### Finding 4 — on lookup questions memory buys speed and costs accuracy

Same headless agent, same model, same tools, answering 6 of the 12 questions
per repo **with vs without** the rendered context in its prompt:

| | file accuracy | symbol accuracy | mean turns | cost (6 questions) |
|---|---|---|---|---|
| **zod** bare | **0.92** | 1.00 | 12.3 | $0.567 |
| **zod** memory | 0.83 | 1.00 | **10.0** (−19%) | **$0.479** (−16%) |
| **lodash** bare | **0.83** | 0.86 | 4.7 | $0.178 |
| **lodash** memory | 0.67 | 0.86 | **3.3** (−29%) | **$0.159** (−11%) |

The speed-up from the previous report reproduces (−19% and −29% turns), but
across two repos it comes with a consistent accuracy cost: the agent stops
searching sooner and names the wrong file more often. The previous report
recorded accuracy as exactly equal (0.83 vs 0.83) on a single run; with a
second repo and a re-run of the first, memory is behind on file accuracy in
both. Symbol accuracy is untouched — the agent still describes the right
mechanism, it just cites a worse location for it.

That trade is only worth taking if the context is right. Given retrieval
recall of 0.46 on lodash, it frequently isn't.

### Finding 5 — the rendered context leaks absolute paths, and an agent will act on them

The first code-change run produced this, and it is worth stating plainly
before the aggregate numbers: in the `fix-bracket-path` task the agent
**correctly diagnosed the bug and edited the wrong copy of the file** — it
followed the absolute path in the memory context (`/tmp/lodash/_stringToPath.js`)
straight out of its working directory and patched the pristine clone the graph
had been ingested from. Its own checkout was left broken, so the fix graded as
a failure, and the benchmark's source repo was silently modified.

`buildContext` copies `node.path` verbatim, and the extractor stores ts-morph's
absolute paths. So a context is only valid on the machine and checkout it was
ingested from. With `Read`-only tools this is invisible; give the agent `Edit`
and it writes outside its workspace.

The harness now rewrites the root prefix onto the working copy and asserts
afterwards that the source clone is untouched. Both aggregates are reported
below, because the difference between them *is* the finding.

### Finding 6 — on real code changes, memory is neutral once its paths are fixed

Three seeded one-line regressions in lodash internals (stable sort tie-break,
bracket path parsing, key-order-insensitive equality). The agent gets only the
user-visible symptom — no file names — and the result is graded by executing
the patched module.

| | fix rate | mean turns | mean duration | cost (3 tasks) |
|---|---|---|---|---|
| bare (no memory) | **3/3** | 13.0 | 36s | $0.256 |
| memory, context as the system emits it | 2/3 | 20.0 | 135s | $0.640 |
| memory, absolute paths rewritten | **3/3** | 12.0 | 33s | $0.245 |

With paths corrected the two conditions are indistinguishable (−8% turns is
well inside noise at n=3). Uncorrected, memory costs 2.5× the money and loses
a third of the fixes.

There is a consistent qualitative difference: bare runs wrote scratch test
files into the repo (1.67 files touched on average) while memory runs touched
only the file they fixed (1.0). Suggestive, not significant at n=3.

Worth noting what this layer *does* confirm: the memory context was measured
in advance to **not contain the correct fix site for any of the five
code-change tasks**, and the agent still fixed 3/3. The agent's own tools
recovered from bad context — which is the same reason accuracy was flat in the
previous report.

### Finding 7 — knowledge does not accumulate across sessions

This is the claim the previous report explicitly could not test (it seeded
invented experiences and said so). Here session 1 fixes a bug, a real
`Experience` built from that run's own output is recorded against the file
nodes it actually edited, and session 2 attacks a different bug one hop away
in the call graph.

| chain | session 1 fix site | session 2 fix site | experience recorded | surfaced in session 2's context? |
|---|---|---|---|---|
| sorting | `_compareMultiple.js` | `_baseSortBy.js` | yes, on 1 node | **no** |
| paths | `_stringToPath.js` | `_castPath.js` | yes, on 1 node | **no** |

Session 2's rendered context was byte-identical before and after the
recording (2357 chars both times). Turns were flat across bare / memory /
memory+episodic (13 / 13 / 13), which is exactly what you'd expect when the
episodic content never arrives.

The mechanism explains it: experiences are hydrated by exact node id
(`hydrateExperiences` → `queryByNode`), so a lesson is only visible if
traversal lands on precisely the node it was attached to. Since retrieval
recall on lodash is 0.46, traversal usually doesn't get there — and being one
import hop away is not enough, because the lookup is not neighbourhood-aware.

Episodic memory is therefore gated behind the weakest layer in the system.
Improving retrieval is a prerequisite for it to do anything at all.

## 3. What did work

Not everything is negative, and these are real:

- **The pipeline survived a 644-file repository unmodified.** Ingest: 644
  files → 1122 nodes / 2923 edges in 13.4s (extract 2.3s, persist 2.0s,
  embeddings 9.1s), and the resulting graph is far richer than zod's (1652
  import + 793 call edges vs 95 + 528). Every one of the 12 questions returned
  a valid `AgentContext`; nothing crashed once `allowJs` was set.
- **The LLM traversal reasoner protocol is solid.** 57 real `claude -p` calls
  across both repos, **zero parse failures**, one call per depth level exactly
  as spec.md §10 specifies.
- **It compresses context hard.** The Claude reasoner cut rendered context by
  57% on zod (2908 → 1278 chars) and 54% on lodash (2390 → 1095) by skipping
  irrelevant branches — at 52–59s per question versus 50–55ms for the
  heuristic.
- **`export const` blindness reproduces exactly as predicted.** lodash has 644
  files but only 478 function nodes. Querying the graph for file nodes with no
  function on their path returns exactly **166** — and every one is a module
  shaped like `var baseFor = createBaseFor(); export default baseFor;` or
  `var f = !x ? identity : function (...) {...}`. They contribute no callable
  node, so traversal can never reach them. Same failure mode the zod report
  identified, on a repo with the opposite idiom: it is a property of the
  extractor, not of zod.

## 4. So: is it useful in real work?

**Not yet, on this evidence — and the previous report's "~30% cheaper" result
does not generalise.**

Being precise about what was and wasn't shown:

- On **lookup questions**, it is beaten by `grep` on both repos, including in
  the multi-hop regime it was designed for. Its one measured advantage over
  grep — ranking — was a metric artefact and disappears when measured
  correctly. Handed to an agent, the context does make it ~20-30% faster and
  cheaper, but it also made the agent name the correct file *less* often on
  both repos.
- On **real code changes**, it is neutral at best: same fix rate, same turns,
  same cost as an agent with no memory at all. Before the path bug was worked
  around, it was actively harmful.
- On **accumulated knowledge**, the value proposition that would justify the
  whole architecture, nothing accumulated: recorded experience never reached
  the next session.
- What is genuinely proven is **engineering soundness**: it ingests real
  repositories fast, the LLM reasoning protocol works reliably, and it makes
  context smaller. Those are necessary but not sufficient.

The honest summary is that the system currently fails at its own value
proposition for a reason that is diagnosable and fixable rather than
fundamental: **retrieval quality is the bottleneck, and every layer above it
inherits the failure.** Traversal can only reason about what retrieval seeds;
episodic can only surface on nodes traversal reaches; the agent can only
benefit from context that points at the right file.

## 5. Recommendations, by measured impact

1. **Fix JS ingestion** (Finding 1). `loadProject()` needs to accept compiler
   options, and `shapeFingerprint` needs to tolerate a missing signature.
   Small, and it unblocks an entire language.
2. **Emit repo-relative paths in the context** (Finding 5). Store the repo
   root on ingest and render paths relative to it. This is a correctness and
   safety bug, not a cosmetic one — an agent with `Edit` will write to
   whatever absolute path you hand it.
3. **Attack retrieval quality — it gates everything else** (Findings 3 and 7).
   Concretely, in the order the evidence supports: a real embedding provider
   (the vector leg is still a hash-embedder stub, so retrieval is essentially
   lexical); LLM-generated `summary` text at ingest, since embedding text is
   currently just name + path; and query preprocessing, because natural
   language questions trigram-match badly ("union" matching `guid`).
4. **Make episodic lookup neighbourhood-aware** (Finding 7). Exact-node-id
   hydration is too brittle to ever fire. Hydrating experiences attached to
   nodes within one hop of the traversed set would have surfaced the lesson in
   both chains here.
5. **Extend the extractor to variable-bound declarations** — still open, now
   confirmed on a second repo (`propose/M10-variable-bound-declarations-draft`
   is the existing draft).
6. **Fix the benchmark's own ranking metric before quoting it again**
   (Finding 2) — done in this harness; the old numbers should not be reused.

## 6. Limitations — read before trusting any number here

- **n is small.** 12 questions per repo, 3 code-change tasks, 2 session
  chains, one run each. Trends, not statistics. Repeated heuristic retrieval
  runs varied by ±0.04 recall on their own.
- **The embedder is fake.** No embedding API in this environment, so the
  vector leg is a token-overlap hash stub. Real embeddings would most plausibly
  improve exactly the multi-hop questions that failed. This is the single
  biggest caveat on Finding 3.
- **The agent model is Haiku 4.5** with `Read/Grep/Glob(/Edit)`. A stronger
  model would likely narrow bare-vs-memory differences further, since bare
  already solves everything.
- **zod's HEAD moved** since PR #17 (32 files now, 29 then), so the control is
  a re-run, not a bit-exact reproduction. Its aggregate barely moved
  (recall 0.79 → 0.75).
- **Ground truth is hand-labeled by one author** (me), by reading the lodash
  source. Every expected file was opened and verified, but a different
  labeller would draw some boundaries differently.
- **Seeded bugs are synthetic.** They are real behavioural regressions with
  executable verification, but they are not bugs that occurred naturally.

## 7. Reproducing

```bash
git clone --depth 1 https://github.com/colinhacks/zod.git /tmp/zod
git clone --depth 1 --branch es https://github.com/lodash/lodash.git /tmp/lodash
export ZOD_DIR=/tmp/zod LODASH_DIR=/tmp/lodash
export DATABASE_URL="postgres://postgres:postgres@localhost:5432/cognitive_memory"
bash scripts/setup-dev-db.sh && pnpm install && pnpm migrate && pnpm build

export BENCH_TARGET=lodash        # or zod
pnpm --filter @cognitive-memory/eval-e2e-benchmark bench:ingest
pnpm --filter @cognitive-memory/eval-e2e-benchmark bench:run
BENCH_REASONER=claude pnpm --filter @cognitive-memory/eval-e2e-benchmark bench:run
pnpm --filter @cognitive-memory/eval-e2e-benchmark bench:agent
pnpm --filter @cognitive-memory/eval-e2e-benchmark bench:patch-contexts
pnpm --filter @cognitive-memory/eval-e2e-benchmark bench:patch
pnpm --filter @cognitive-memory/eval-e2e-benchmark bench:session
```

Every number above is read from `eval/e2e-benchmark/results/{zod,lodash}/`,
committed alongside this report:
`ingest.json`, `run-system-{heuristic,claude}.json`, `contexts-*.json`,
`agent-compare.json`, `patch-compare.json`,
`patch-compare-absolute-paths.json` (the pre-fix run behind Finding 5),
`session-chain.json`.
