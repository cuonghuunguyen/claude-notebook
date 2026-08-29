# Roadmap

Implementation milestones for `spec.md`. Each milestone is independently
buildable and testable — a milestone is not "done" until its acceptance
criteria pass in CI, not just locally. Milestones are built in order; later
ones depend on earlier package contracts, not on earlier milestones being
feature-complete.

## Status

This checklist is the source of truth for what's done — see
`AGENT_HARNESS.md` if you're a session picking this up cold.

- [x] M0 — Scaffolding (pnpm monorepo, Postgres+pgvector+pg_trgm schema, graph-store)
- [x] M1 — Structural Graph (ts-morph extractor, node identity, incremental updates)
- [x] M2 — Hybrid Retrieval
- [x] M3 — Semantic Memory Pipeline
- [x] M4 — Episodic Memory
- [x] M5 — Reasoning-Guided Traversal
- [x] M6 — Context Construction
- [x] M7 — Staleness, Events, GC, Full Eval Set
- [x] M8 — Multi-Language Structural Extraction (Python via `tree-sitter`, approved — see CLAUDE.md)
- [x] M9 — Pipeline Orchestration
- ~~M10 — Structural Extraction: Variable-Bound Declarations~~ — **superseded,
  never built** (knowledge-first pivot, human-directed 2026-08-19; see spec §24
  and the M10 section note below)
- [x] M11 — Knowledge Layer as Product (by-meaning retrieval + capture — git-history mining AND session scout-report distillation — shipped into `packages/`)
- [x] M12 — Text Anchors & Commit-Triggered Staleness (git replaces the AST for anchoring and staleness)
- [x] M13 — Refine-Memory Skill (read-repair + `supersedes` links)
- [x] M14 — Knowledge-Link Edges (spike: memory-to-memory traversal, go/no-go on a measured win) — **outcome: NO-GO on integrating; `follows_up` a hard no. See BENCHMARKS.md**
- [x] M15 — Decommission the Structural Graph (gate passed: by-meaning MRR **0.85** lexical / **0.90** with the stub embedder, *identical* with 501 structural nodes present and with none; node-gated arm **0.00** in both. See BENCHMARKS.md)
- [x] M16 — Memory Tiers: short/mid/long-term with access-driven promotion (extends §7/§18)
- [x] M17 — Storage Backend: Port to SQLite (removes Postgres+pgvector+pg_trgm; spec §25) — gate MOVED rather than held: MRR **0.883/0.933**, recall **1.00**, from `ts_rank` → `bm25()`; reported in spec §25.8, not re-baselined
- ~~M18 — Memories as Markdown, Index as Projection (spec §25.6)~~ —
  **deferred, not built** (human decision 2026-08-27, taken after the
  implementation had been designed and started): the milestone's own gate is
  "MRR unchanged", so it ships no measured retrieval gain, and this
  repository's memories are mined commit bodies that git already stores and
  `git log --grep` already greps. See the M18 section note below and spec
  §25.6.1.
- [ ] M19 — Distilled Memories (spec §26) — **built and measured 2026-08-28; the box stays unchecked because the measurement did not clear §26.5's bar.** Injected context −19% and turns on fired prompts 6.5 → 4.5, against a halved citation rate (4/19 → 2/19), +38% wall, still +43% cost over grep+git, and ~$8.4 of one-time spend. The blind judge's 11/6/2 → 4/14/1 flip is reported as uninterpretable: on the 7 prompts where the hook did not fire — configuration-identical arms — the judge picked the memory file 6/7, where the prior run's same control was a balanced 3/3/2, so the noise floor moved between runs. See spec §26.6 and BENCHMARKS.md.

Repo layout target:

```
spec.md
ROADMAP.md
docker-compose.yml            # local Postgres+pgvector for contributors without a local cluster
migrations/
  0001_init.sql
  0004_experiences_content_search.sql   # M11: knowledge is searchable by its own content
  0006_experience_anchors.sql           # M12: text anchors + commit-triggered staleness
  0007_supersede_chains.sql             # M13: supersede links + verification stamps
packages/
  core/                       # shared types (Provenance, Experience, Anchor, MemoryTier) + the embedder contract
  graph-store/                # Postgres client, migration runner, typed CRUD for experiences/events/tiers
  episodic/                   # M4: experience capture/query per spec §8; M11: by-meaning retrieval per spec §24.2.1
  context/                    # M6: subgraph -> compact agent context per spec §17
  pipeline/                   # M9: task -> AgentContext orchestration per spec §22
  capture/                    # M11: git-history mining + scout-report distillation per spec §24.2.1
  staleness/                  # M12: text anchors + git-driven memory staleness per spec §24.2.2-3
  tiers/                      # M16: access-driven tier promotion per spec §24.5
  gc/                         # M7: retention signal over memories per spec §18
eval/                         # eval sets, spec §19: why-spike (M11 knowledge retrieval),
                              # link-spike (M14 go/no-go), tier-promotion (M16)
```

M15 removed five packages from that list — `structural` (M1's ts-morph
extractor), `structural-python` (M8's tree-sitter one), `retrieval` (M2's
hybrid node search), `semantic` (M3's edge-promotion pipeline) and `traversal`
(M5's reasoning-guided expansion) — along with `eval/retrieval`,
`eval/staleness`, `eval/traversal-cost` and `eval/e2e-benchmark`'s harness. The
milestone sections for M1-M8 below are kept as written: they are the record of
what was built and measured, not a description of the current tree. Where a
later section contradicts an earlier one, the later one is current.

---

## M0 — Scaffolding (no product behavior yet)

**Goal:** a monorepo that installs, typechecks, and runs an empty test suite
in CI, plus a database schema that matches `spec.md` §3-§4 and actually
migrates against Postgres+pgvector+pg_trgm.

- pnpm workspace, `tsconfig.base.json`, vitest, eslint.
- `packages/core`: TS interfaces for `Node`, `Edge`, `Provenance`,
  `Experience`, `NodeType`, `RelationType` — copied faithfully from spec.md,
  this package is the contract every other package imports against.
- `migrations/0001_init.sql`: tables for nodes, edges, experiences, evidence,
  events. `vector` column + HNSW index on `nodes.embedding`. `pg_trgm` GIN
  index on `nodes.name`/`nodes.path`. Node id is text (hash), not
  serial/uuid, per spec.md §3.2.
- `packages/graph-store`: thin `pg` wrapper + migration runner + typed
  insert/select helpers. No business logic.

**Acceptance:** `pnpm install && pnpm -r build && pnpm -r test` passes with
zero packages beyond core/graph-store. `pnpm --filter graph-store migrate`
applies `0001_init.sql` against a real Postgres and is idempotent (running
twice is a no-op, not an error).

## M1 — Structural Graph (spec §2.1, §3.2, §5)

**Goal:** point the extractor at a TS/JS repo, get `file`, `class`,
`function`, `method`, `import`, `call` nodes/edges written to graph-store,
matching identity rules in spec §3.2.

- `packages/structural`: walk the target repo with `ts-morph`, emit
  Node/Edge batches conforming to `packages/core` types. `sourceType:
  "source_code"` provenance, `confidence: 1.0`.
- Incremental mode: given a changed-files list (from `git diff`), only
  reparse those files and their direct importers; delete/update per §3.2
  identity rules instead of full rebuild.
- Node id = `hash(repoId, stableSymbolPath)` as specified — implement and
  unit-test the hash function in isolation first, everything else depends on
  it being stable across a rename.

**Acceptance:**
- Fixture test (no DB): parse a small fixture TS project, assert exact
  expected node/edge set.
- Rename test: rename a function in the fixture, rerun incremental extract,
  assert the node's id is unchanged and only `path`/`updatedAt` changed (not
  a delete+create).
- Delete-and-recreate test: change a function's name AND move it to a
  different file with no rename signal, assert old node → `deleted`, new
  node created, old edges → `stale` (not dropped).
- Integration test (gated on `DATABASE_URL`): same fixture, written through
  `graph-store` into real Postgres, read back matches.

## M2 — Hybrid Retrieval (spec §9)

**Goal:** `query: string -> seed nodes`, combining `pg_trgm` lexical search,
pgvector similarity, and the 1-hop/semantic-neighbor seed expansion from
spec §9.

- `packages/retrieval`: lexical leg (trigram similarity threshold + rank),
  vector leg (embedding similarity, requires an embedding provider — stub
  with a deterministic fake embedder in tests, real provider wired via
  config), merge + de-dupe, then seed expansion.
- Embedding provider is an injected interface, not hardcoded — this package
  must not hard-depend on a specific embedding API.

**Acceptance:** eval fixture with ~20 hand-labeled (query -> expected node
ids) pairs against the M1 fixture project; retrieval hits the expected node
in the seed set (including via 1-hop expansion, not just direct hits) for
every fixture query. This is the first slice of the spec §19 eval set —
keep it in `eval/retrieval/` so M7 extends it rather than starting over.

## M3 — Semantic Memory Pipeline (spec §6-§7, §13)

**Goal:** implement the observation → candidate → durable promotion table
from spec §7 as actual code with actual thresholds, plus conflict resolution
(§13) and `disputed` status.

- `packages/semantic`: given a set of provenance records touching the same
  `(from, to, relation)` triple, compute stage per §7's table, write/update
  the semantic edge, set `disputed` when the evidence hierarchy doesn't
  cleanly resolve a conflict.
- LLM-proposed edges enter as `observation`-stage provenance only; nothing an
  LLM proposes writes a `durable` edge directly.

**Acceptance:** unit tests encoding the exact promotion-table cases from
spec §7 (single observation stays a hypothesis; 2 observations from 2
distinct sourceTypes reach `candidate` capped at 0.75; a verification pass
unlocks `durable`; two source_code-confidence-0.8 vs llm_inference-confidence
-0.95 facts resolve per §13, not by raw confidence). This is the spec §19
"promotion correctness" eval, built as tests rather than deferred to later.

## M4 — Episodic Memory (spec §8)

**Goal:** append-only experience store, queryable by related node, feeding
M3's promotion pipeline as `sourceType: "agent_experience"` provenance.

- `packages/episodic`: `recordExperience`, `queryByNode`, `queryByTask`.
  Strictly append-only — no update/delete API surface at all, so "episodic
  memory is append-only" from spec §8 is enforced by the package boundary,
  not just documentation.

**Acceptance:** round-trip test; a recorded experience with a repeatable
lesson flows into M3's promotion pipeline and reaches `candidate` stage per
the same table as M3's tests.

## M5 — Reasoning-Guided Traversal (spec §10-§11)

**Goal:** seed nodes + task -> expanded subgraph, using the frontier-batched
reasoning model from spec §10 (one LLM call per depth level, not per edge)
and the ranking formula from §11 to pre-filter each frontier.

- `packages/traversal`: per depth level, fetch frontier via one batched
  recursive-CTE query (spec §16), rank with §11's formula, cap to top-N
  before handing to the reasoning call, apply EXPAND/SKIP/STOP decisions,
  enforce `TraversalBudget`.
- Reasoning call is an injected interface (like M2's embedder) so it's
  testable with a scripted fake decision-maker, not a live LLM, in unit
  tests.

**Acceptance:** budget-exhaustion test (frontier larger than `maxNodes`
still terminates within budget); a scripted-reasoner test proving one
reasoning call handles a whole frontier, not one call per edge (assert call
count == depth levels visited, not == edges visited).

## M6 — Context Construction (spec §17)

**Goal:** subgraph -> the compact projection described in spec §17 (relevant
subsystem, relationships, invariants, prior experience, source files) —
plain templating over the subgraph, no new LLM call required here.

**Acceptance:** given a fixed subgraph fixture, output matches an expected
compact-context snapshot.

## M7 — Staleness, Events, GC, Full Eval Set (spec §12, §14, §18, §19)

**Goal:** wire the event log (spec §14) through all of M1-M6 so the graph is
a genuine projection over events, implement lazy stale-edge verification
(§12), and implement the GC/retention rules from §18. Extend the M2/M3 eval
slices into the full spec §19 eval plan (staleness-accuracy and
traversal-cost tracking specifically, the two pieces M2/M3 didn't cover).

**Acceptance:** rebuild-from-events test (wipe materialized graph, replay
event log, diff against pre-wipe state — must match); injected-refactor
staleness test per spec §19 point 2; GC batch job test confirming the 90/30
day retention windows from §18.

## M8 — Multi-Language Structural Extraction (spec §21)

**Proposed via `/propose-milestone`, approved by a human — see the
"Approved" note below and `CLAUDE.md`'s locked-stack rule.** Adding a
second language extractor meant picking a new parsing/type-resolution
library; that stack addition (`tree-sitter`) has been confirmed, so
`/next-milestone` can build this milestone without re-flagging the
dependency as a new deviation.

**Approved:** `tree-sitter` (with its Python grammar) is the
parsing/symbol-resolution library for this milestone — no longer an open
choice, confirmed per `CLAUDE.md`'s locked-stack rule.

**Goal:** prove spec §21's additional-language-extractor contract with one
real second language (Python, via `tree-sitter`), producing the exact same
`packages/core` Node/Edge shape M1 already defines, through the same
incremental-update path as M1.

- A per-language structural extractor for Python (new package, e.g.
  `packages/structural-python`, or an extractor registry inside
  `packages/structural` — implementer's call) using `tree-sitter` with its
  Python grammar for AST/symbol resolution. Emit `file`, `class`,
  `function`, `method`, `import`, `call` nodes/edges conforming to
  `packages/core` types, `sourceType: "source_code"` provenance at
  `confidence: 1.0`, same as M1.
- Node id via the same `hash(repoId, stableSymbolPath)` scheme (spec §3.2),
  with `stableSymbolPath` resolved by the new tool's own symbol/qualified-
  name resolution — implement and unit-test this in isolation first, same
  discipline M1 used for the TS/JS hash, since it's the same stability
  guarantee resolved by a different tool.
- Incremental mode: same contract as M1 — given a changed-files list, only
  reparse this language's affected files and update graph-store
  accordingly; delete/update per §3.2 identity rules, not a full rebuild.

**Acceptance:**
- Fixture test (no DB): parse a small fixture Python module, assert an
  expected node/edge set analogous to M1's TS/JS fixture test.
- Rename test: rename a function in the fixture, rerun incremental extract,
  assert the node's id is unchanged (only `path`/`updatedAt` changed).
- Delete-and-recreate test: change a function's name AND move it to a
  different file with no rename signal available from the new tool, assert
  old node → `deleted`, new node created, old edges → `stale`.
- Integration test (gated on `DATABASE_URL`): same fixture, written through
  `graph-store` into real Postgres, read back matches — this is the actual
  point of spec §21 (extractors are additive to the existing contract, not
  a rewrite of it), so this test must pass against the SAME `graph-store`
  code M1-M7 already use, unmodified.
- Cross-language regression guard: run the existing TS/JS fixture and the
  new Python fixture through the same repo/project extraction together and
  assert neither extractor's output corrupts or mistypes the other's nodes
  — this is the exact failure mode this milestone's own proposal
  demonstrated pre-fix (a non-TS/JS file silently mis-parsed as TypeScript,
  producing a wrong node type and, on deeper inspection, an unhandled
  compiler exception): see the PR that added this section for the captured
  repro.

## M9 — Pipeline Orchestration (spec §22)

**Proposed via `/propose-milestone`** — demonstrated gap: `packages/retrieval`,
`packages/traversal`, and `packages/context` have zero dependency edges on
each other (verified via `package.json`) and their exported types don't
compose (`retrieveSeeds` returns `SeedNode[]` where `traverse` expects
`seedNodeIds: string[]`; `traverse` returns `TraversalResult` where
`buildContext` expects a `Subgraph`, with no node-hydration step anywhere
bridging the two). A direct `tsc` of the naive composition
`traverse(seeds, ...)` / `buildContext(traversalResult, ...)` fails with
`Argument of type 'SeedNode[]' is not assignable to parameter of type
'string[]'` and `Property 'nodes' is missing in type 'TraversalResult' but
required in type 'Subgraph'` — see the PR that added this section for the
captured repro. No caller in the workspace (test or otherwise) currently
goes from a task string to an `AgentContext`.

**Goal:** implement spec §22's `runPipeline(task, options)` composing the
existing M2/M5/M6 contracts — no new external dependency, no change to any
package's existing public API.

- New package `packages/pipeline`: `runPipeline` per spec §22's steps 1-7 —
  shared task-embedding computation, `retrieveSeeds` → `traverse` →
  node/experience hydration (`getNodesByIds`, `queryByNode`, both already
  exported by `graph-store`/`episodic`) → `buildContext`.
- Empty-seed short-circuit per spec §22 point 3: zero retrieval hits returns
  an empty `AgentContext`, not a thrown error.
- `maxExperiences` cap per spec §22 — bounded regardless of subgraph size.
- Depends only on already-existing workspace packages (`retrieval`,
  `traversal`, `graph-store`, `episodic`, `context`, `core`) — adding these
  as dependency edges in `packages/pipeline/package.json` is in scope;
  modifying any of those five packages' existing exports is not.

**Acceptance:**
- Unit test with fixture `GraphProvider`/`ReasoningProvider`/`EmbeddingProvider`
  fakes (same pattern M5/M2 already use): a task string that matches a
  fixture node produces an `AgentContext` with the expected subsystems/
  relationships/experiences, in one `runPipeline` call — no per-stage glue
  in the test itself.
- Empty-seed test: a task matching nothing in the fixture returns
  `{ subsystems: [], relationships: [], invariants: [], experiences: [],
  sourceFiles: [] }` (per spec §22 point 3), and asserts `traverse` was
  never called (the short-circuit actually short-circuits, not just
  produces an empty result via a wasted traversal call).
- Shared-embedding test: with a spy `EmbeddingProvider`, assert `embed()` is
  called exactly once per `runPipeline` invocation, not once per stage.
- Integration test (gated on `DATABASE_URL`): real Postgres graph-store +
  the M1 fixture project's nodes, a scripted (non-LLM) reasoner, asserting
  the returned `AgentContext`'s `sourceFiles`/`relationships` match the
  fixture's known structure — this is the actual point of spec §22 (the
  stages compose for real, not just against in-memory fakes).
- Experience-hydration test: seed the episodic store with a `recordExperience`
  call for a node the traversal reaches, assert it surfaces in the returned
  `AgentContext.experiences` — this is the first real (non-test-only)
  exercise of episodic memory's read path from outside its own package.

## M10 — Structural Extraction: Variable-Bound Declarations (spec §23) — SUPERSEDED

> **Superseded 2026-08-19 by direct human decision — do not build.** The
> knowledge-first pivot (spec §24) removes the premise this milestone rests
> on: memories no longer bind to structural node ids, so extending node
> coverage buys nothing. The measured gap it cites (zero-hit retrieval on
> `export const` files) is answered instead by M11's by-meaning retrieval,
> which does not route through node hits at all (WHY_MEMORY_SPIKE.md: MRR
> 0.75 by content vs 0.13 node-gated). Text preserved below for the record.

**Proposed via `/propose-milestone`** — demonstrated gap: the real-world E2E
benchmark added in `eval/e2e-benchmark/` (see `E2E_BENCHMARK_REPORT.md`, a
real run against zod v4's `packages/zod/src/v4/{classic,core}`, 29 files /
~42,000 lines) measured that M1's TS/JS extractor produced 326 `function`
nodes but only 6 `class` nodes from that codebase, because zod v4 defines
almost all of its schema constructors as `export const X = $constructor(...)`
(a call-expression-initialized `const`, not an ES6 `class`) and many helpers
as `export const foo = (...) => {...}` (arrow functions, not `function`
declarations) — patterns `sourceFile.getFunctions()`/`getClasses()` never
see. 2 of the benchmark's 12 hand-labeled retrieval questions failed with
**zero** hits because their ground-truth files (`regexes.ts`, `errors.ts`)
consist entirely of `export const` bindings with no corresponding node in
the graph at all — a coverage gap, not a ranking one. See spec §23 for the
full decision and evidence.

**Goal:** extend `packages/structural`'s TS/JS extractor to emit a node for
every module-level `VariableDeclaration`, per spec §23's decision — no
change to `packages/core`'s `NodeType` enum (`function`/`variable` already
exist), no change to any other package's public API.

- Walk each source file's module-level `VariableDeclaration`s (nested
  declarations inside a function/block body stay out of scope, same as
  `getFunctions()`/`getClasses()`'s existing top-level-only reach).
- Initializer is an arrow function or function expression → emit a
  `function` node, identity via `shapeFingerprint` generalized to accept
  `ArrowFunction`/`FunctionExpression` (not just `FunctionDeclaration`/
  `MethodDeclaration`) — same name-independent, rename-survives contract.
  Extend pass 2's call-resolution (`extract.ts`) so a call into one of
  these resolves a `calls` edge exactly like a call into a `function`
  declaration already does.
- Any other initializer → emit a `variable` node, identity via a new
  initializer-fingerprint (hash of the initializer expression's text,
  excluding the binding's name) — same "rename survives, value-change
  doesn't" contract, generalized from function shape to value shape.
- Both kinds get a `contains` edge from their containing file, `sourceType:
  "source_code"` provenance at `confidence: 1.0` — identical convention to
  every existing M1 node.
- Incremental mode: same contract as M1/§5 — a changed file's variable
  declarations are removed/recreated per §3.2 identity rules alongside its
  functions/classes, not a parallel mechanism.

**Acceptance:**
- Fixture test (no DB): a fixture module reproducing the three patterns the
  benchmark actually found missing — `export const add = (a, b) => a + b`
  (arrow-function-bound), `export const DEFAULT_TIMEOUT = 5000` (plain
  value), `export const Circle = makeShape("circle", 1)` (factory-call
  pattern, mirroring zod's `$constructor(...)`) — asserts each produces the
  expected node type (`function`/`variable`/`variable` respectively) and
  `contains` edge.
- Rename test: renaming one of these bindings (initializer unchanged) keeps
  the same node id, for both the `function`-typed and `variable`-typed
  cases.
- Delete-and-recreate test: changing a binding's initializer AND moving it
  to a different file with no rename signal is a delete+create (old node →
  `deleted`, new node created, old edges → `stale`) — same shape as M1's
  existing delete-and-recreate test.
- Call-resolution test: a `function` declaration that calls an arrow-
  function-bound `const` resolves a `calls` edge, same as calling a
  `function`-declaration callee.
- Integration test (gated on `DATABASE_URL`): the fixture module written
  through `graph-store` into real Postgres, read back matches — same
  `graph-store` code M1/M8/M9 already use, unmodified.
- Coverage regression guard: a small synthetic fixture shaped like the
  benchmark's actual failure (a file consisting entirely of `export const`
  literal bindings, no functions/classes at all) must produce at least one
  node per binding — this is the exact shape of the two zero-hit retrieval
  questions the benchmark measured; see `E2E_BENCHMARK_REPORT.md` and the
  PR that added spec §23 for the captured evidence.

---

## M11 — Knowledge Layer as Product (spec §24)

**Human-directed pivot (2026-08-19).** The measured case: the structural
graph loses to grep at code location in every regime on both benchmark repos
(`E2E_BENCHMARK_MULTI_REPO.md`), while recorded-reasoning memory mined from
git history cut agent work 7.7 → 1.4 turns at −47% cost
(`WHY_MEMORY_SPIKE.md`) — and did it by retrieving experiences **by their own
content** (MRR 0.75) rather than through node hits (the shipped node-gated
path: MRR 0.13). The winning paths live only in `scripts/self-memory.mjs` and
`eval/why-spike/`; nothing in `packages/` produces or content-searches an
experience. This milestone ships them.

**Goal:** the knowledge layer becomes the product surface of `packages/`.

- Migration: content-search capability on `experiences` — pg_trgm index on
  experience text + embedding column/HNSW index (the table today has indexes
  only on `related_nodes` and `timestamp`; it cannot search knowledge by
  content).
- `packages/episodic`: a by-meaning query API — hybrid text + embedding
  search over experience content, mirroring §9's hybrid shape but over
  experiences, **not** gated on any structural node hit.
- Capture as a package (new `packages/capture` or grown inside episodic),
  two source classes per spec §24.2.1:
  - the why-spike's git-history miner (self-explaining commits, revert
    references, PR/issue linkage) as an idempotent API — re-running over
    the same history writes nothing new, same contract as
    `self-memory.mjs sync`;
  - a session-distillation API (`recordScoutReport` or similar): persist
    the synthesized what/how understanding an agent builds while scouting
    (subsystem maps, how-X-works, gotchas) with text anchors to the files
    it covers — wired into this repo's own hooks as the dogfood producer.
    Guardrail (spec §24.2.1): distilled understanding only, never bare
    file locations — grep owns those, measured.
- `packages/pipeline`: `runPipeline` surfaces by-meaning experience hits
  directly in `AgentContext.experiences`, no longer only node-hydrated ones.

**Acceptance:**
- Migration is idempotent (applies twice cleanly).
- Unit: a by-meaning query returns a relevant experience whose
  `related_nodes` is empty — proving retrieval is not node-gated.
- Capture idempotency test: mining the same fixture history twice produces
  no duplicate experiences.
- Scout-capture test: a recorded scout report is retrievable by meaning
  (a paraphrased how-does-X-work query returns it), and its anchors are
  plain text paths — no structural node required to exist.
- Re-run the why-spike retrieval harness through the shipped package path
  (integration, gated on `DATABASE_URL`): by-meaning MRR must land in the
  neighborhood of the spike's 0.75 and decisively above the node-gated
  0.13 — record the real number in `BENCHMARKS.md`.

## M12 — Text Anchors & Commit-Triggered Staleness (spec §24)

**Goal:** memories bind to plain-text anchors — `{ path, symbol? }` (file
path plus optional symbol name as text, never line numbers) — instead of
structural node ids, and staleness is driven by git, not by AST diffing.

- `packages/core`: `Anchor` type; experiences carry `anchors: Anchor[]`
  alongside (eventually instead of) `related_nodes`.
- Capture/sync marks a memory **suspect** when a commit touches an anchored
  path (file-level trigger; follows git renames via `--follow`/rename
  detection rather than treating a rename as a delete).
- Retrieval-time staleness flag: if the last commit touching a memory's
  anchored paths is newer than the memory itself, the returned context tags
  it `possibly-stale — verify before trusting`. One git lookup, no parser.
- Suspect memories are still returned (flagged), never silently dropped —
  the why-spike showed missing context is a cost too; the flag is the
  compromise.

**Acceptance:**
- Unit: anchor matching against a changed-paths list, including a
  renamed-file case resolving to the same anchor.
- Unit: commit newer than memory ⇒ flag present; memory newer than last
  commit ⇒ no flag.
- Integration (gated on `DATABASE_URL`): sync over a fixture repo's history
  marks exactly the memories anchored to the changed files as suspect.

## M13 — Refine-Memory Skill (read-repair + supersedes) (spec §24)

**Goal:** staleness gets *repaired* where it is *noticed* — at read time.

- Migration + `packages/episodic`: a `supersedes` link between experiences.
  Retrieval excludes superseded memories by default (the chain's newest
  memory answers; history remains queryable explicitly).
- `.claude/skills/refine-memory`: retrieve a memory → read its anchored
  files and `git log` since its timestamp → if stale, write a corrected
  memory that supersedes the old one (and clear the suspect mark); if still
  accurate, just clear the mark.
- Wire into this repo's own loop: `self-memory.mjs ask` output flags stale
  hits and names the skill, so dogfooding exercises read-repair naturally.

**Acceptance:**
- Unit: superseded memories excluded from by-meaning retrieval; explicitly
  included when asked for history.
- Integration: supersede chain of length 3 returns only the head.
- Dogfood evidence in the PR: the skill run against one genuinely stale
  memory in this repo's own graph, before/after shown.

**Shipped.** Migration 0007 adds `superseded_by` / `superseded_at` /
`verified_at`; one shared visibility predicate excludes superseded memories
from *every* experience query (not only the by-meaning legs), with
`includeSuperseded` for explicit history; `packages/episodic`'s
`recordSupersedingExperience` writes the correction and its link in one
transaction; `.claude/skills/refine-memory` is the read-repair protocol and
`self-memory.mjs` gained `suspects` / `show` / `verify` / `supersede` /
`history` for it to drive.

One decision M13 had to make that the criteria above do not name, recorded
in spec.md §24.6: **verification is an instant, not a flag**. §24.2.3's
verdict is recomputed from git at read time as well as persisted, so
"just clear the mark if accurate" cannot be a flag flip — the commit that
raised it stays newer than the memory forever and the next read re-derives
the same verdict. A memory carries `verified_at` and staleness measures from
`max(timestamp, verified_at)`.

## M14 — Knowledge-Link Edges (spike — go/no-go, not a feature) (spec §24)

**Goal:** test whether memory-to-memory edges are worth building before
building them. Call-graph traversal lost to grep because grep can
reconstruct code relations from source; relations *between memories*
(commit B reverts commit A; fix and regression share an incident) are not
in the source at all — but that argument is currently unproven, so this
milestone is explicitly a measured spike, mirroring `WHY_MEMORY_SPIKE.md`'s
method.

- Miner: derive candidate edges from git metadata only — revert references
  ("This reverts commit …"), shared PR/issue numbers, same-files-within-a-
  time-window follow-ups.
- Hand-check edge precision on a labeled sample (target: a real number in
  the report, not an assertion).
- Benchmark: why-spike-style A/B — answers built from the hit memory alone
  vs hit memory + 1-hop linked memories — on questions whose ground truth
  spans two commits (e.g. change + its revert).

**Acceptance:**
- Edge-miner unit tests on fixture histories (revert / issue-ref / window).
- A written go/no-go in `BENCHMARKS.md` with the measured before/after. A
  null result is a valid outcome: log it honestly and do NOT integrate
  traversal into the pipeline — per the repo rule, no fabricated rows.

**Outcome (shipped 2026-08-20, spike lives in `eval/link-spike`): NO-GO.**
Nothing was integrated into `packages/` or `runPipeline`, and no migration was
added. The measured result, in full, is the go/no-go section of
`BENCHMARKS.md`; the short version:

- Budget-fair A/B (K=5, 10 two-slot questions, corpus `colinhacks/zod @
  870433f3`): by-meaning 0.60 → linked 1-hop **0.90** bothSlots. A
  random-rewired control spending the *same* budget stays at 0.60 across 6
  seeds, so the neighbour's identity — not the extra memory — is what acts.
- But only 3 of 10 questions flip (sign test **p = 0.125**), and in **all
  three** the by-meaning context already cited the missing commit's PR number
  in prose. The win is automatic dereference of an existing pointer plus a
  ~3× budget saving, **not** recovery of knowledge absent from the source.
  M14's strong hypothesis is therefore unsupported on this corpus.
- Hand-checked precision (25 labelled pairs): `reverts` 1.00 (n=1),
  `shares_issue` 1.00 (n=12), `follows_up` **0.00 (n=12)**. `follows_up` is
  70% of all mined edges and contributes nothing to the A/B either — a
  strong-relations-only arm matches the full one. Do not build it. Quote the
  **population-weighted 0.301**, not the 0.52 stratified mean.
- The two surviving relations cover only **27%** of memories (vs 69% for all
  three), and `shares_issue` alone is 26.3% of that — `reverts` contributes a
  single edge. A sparse high-precision layer, not general traversal.
- Two threats an independent review pass found, which are why this is a no-go
  rather than a narrow go: no gold slot sits at by-meaning ranks **3-6**, so
  the slots the link arm displaces were worthless *by construction* and the
  "equal budget" trade-off was never actually priced; and the baseline ran with
  **0 embeddings**, i.e. 2 of `queryByMeaning`'s 3 legs. Both are written up as
  T1/T2 in BENCHMARKS.md with the fix each would need.

**Consequence for M15:** treat M14 as *no evidence for* a memory-graph
traversal layer. It is not evidence against by-meaning retrieval, and it does
not by itself justify keeping the structural graph either.

## M15 — Decommission the Structural Graph (gated on M11–M14) (spec §24) — DONE

**Gate result (measured 2026-08-21, before anything was deleted):** the eval
set was re-run through the knowledge-first pipeline in four conditions — with
the zod v4 structural graph fully ingested (501 nodes, 1171 edges) and with an
empty `nodes` table, each lexical-only and with the stub embedder. By-meaning
scored **MRR 0.85 / recall 0.90** lexical-only and **MRR 0.90 / recall 0.90**
with the embedder — *the same in both node conditions* — and the node-gated arm
scored **0.00** in both, returning ten memories per question with the graph
present and never the answering one. Nothing measurably depended on structural
nodes, so removal proceeded. The post-removal re-run reproduces 0.85 / 0.90
exactly. Full numbers, method and reproduction steps: `BENCHMARKS.md`.


**Goal:** once nothing load-bearing reads structural nodes — retrieval is
by meaning (M11), anchors are text (M12), staleness is git-driven (M12) —
remove the machinery: `packages/structural`, `packages/structural-python`,
the symbol-graph traversal path, and the schema surface only they used.

Gate, not a formality: this milestone may only start after M11 and M12 are
merged AND a re-run of the existing eval sets through the knowledge-first
pipeline shows no regression vs the `BENCHMARKS.md` baseline. If something
still measurably depends on structural nodes, that finding blocks this
milestone and gets written down instead.

**Acceptance:**
- `pnpm -r build && pnpm -r test` green with the packages removed.
- Pipeline eval re-run post-removal recorded in `BENCHMARKS.md`, no
  regression vs the pre-removal baseline.
- Migration retires now-unused columns/indexes (e.g. node-gating surfaces),
  idempotent as always; `experiences` data is preserved.

**What shipped** (all three acceptance bullets met — see `BENCHMARKS.md` for
the numbers and the reproduction steps):

- **Removed**: `packages/structural`, `packages/structural-python`,
  `packages/traversal`, `packages/semantic`, `packages/retrieval`;
  `graph-store`'s `nodes.ts` / `edges.ts`; `staleness`'s §12 edge verifier;
  `gc`'s edge-based cold-storage rule; `episodic`'s `queryByNode`;
  `context`'s four code sections; `core`'s `Node` / `Edge` / `RelationType` /
  `TraversalBudget` / `nodeId()`; `eval/retrieval`, `eval/staleness`,
  `eval/traversal-cost`, and `eval/e2e-benchmark`'s harness. ~10,300 lines
  deleted against ~1,000 added.
- **`runPipeline` lost its whole structural stage.** §22 was
  seeds → traverse → hydrate nodes → hydrate memories on those nodes →
  interleave with by-meaning. It is now embed once → by-meaning →
  read-time staleness → `buildContext`. There is no seed-miss short-circuit
  left to get wrong, because "the graph has no node for this task" is no
  longer expressible (§24.3).
- **`migrations/0008_decommission_structural.sql`** drops `edges` then
  `nodes` (`IF EXISTS`, idempotent). Verified on a populated database:
  144 memories before and after with an identical content hash, `anchors`,
  `related_nodes` and embeddings untouched, and the `events` log — including
  1,903 pre-M15 `SymbolAdded` / `RelationAdded` rows — intact.
- **`experiences.related_nodes` and its GIN index deliberately STAY.** The
  column is named for node ids but since M11 it carries text anchors, and
  `listExperiencesByAnchorPaths` matches on it so that pre-M12 memories —
  which have anchors *only* there — stay findable by §24.2.3's staleness pass.
  Dropping it would have been silent data loss dressed as cleanup.
- **§14 stays honest about old logs.** `materializer.ts` accepts the six
  retired structural event types, skips them, and *counts* the skips, so
  `rebuildFromEvents` succeeds on any database that ever ran an extraction
  instead of throwing on the first `SymbolAdded` it meets. Verified against
  this repository's own log: 1,903 skipped, 144 memories replayed to a
  byte-identical content hash.
- **`scripts/self-memory.mjs sync` no longer parses anything.** It was
  ts-morph over `packages/**/*.ts` plus a git mine; it is now the git mine
  and the staleness pass, which is why it works for a repository in any
  language (§24.2 point 7) and finishes in ~240ms.

## M16 — Memory Tiers: Access-Driven Promotion (spec §24.5)

**Goal:** short-term → mid-term → long-term memory tiers, promoted by real
cross-session access, demoted by decay — extending §7's promotion lifecycle
with a usage axis and giving §18's GC its retention signal.

- Migration: `tier`, `access_count`, `last_accessed`, `distinct_sessions`
  on experiences; retrieval performs write-on-read access accounting.
- Promotion rules per spec §24.5: capture lands short-term; a distinct
  session's retrieval promotes to mid-term; sustained multi-session access
  promotes to long-term. Fix the numeric thresholds from eval data in this
  milestone and write them into §24.5, §7-style.
- **Solve §24.5's open problem first: access ≠ correctness.** Raw
  retrieval counts must not be the promotion signal, or a
  plausible-but-wrong memory climbs tiers. Candidates documented in
  §24.5 (verification-gated promotion; task-outcome feedback joined from
  the quality gate's pass/fail records; used-vs-ignored citations from
  the agent). This milestone picks one — or a better one — and writes the
  decision + its measured justification back into §24.5. A pure
  access-count implementation is an automatic review failure.
- Demotion: tier-specific idle windows drop a tier; idle short-term
  memories become §18 GC candidates; long-term is never GC'd for coldness
  alone.
- Ranking: tier is a §11 score multiplier in by-meaning retrieval — never
  a filter; add the boost to the retrieval scorer with all tiers still
  searched.

**Acceptance:**
- Unit: full transition table — promote short→mid on distinct-session
  access, mid→long on sustained access, decay demotions, GC candidacy;
  same-session repeat hits do NOT promote (no self-promotion).
- Unit: the chosen usefulness signal gates promotion — an access whose
  signal is negative (stale verdict / failed task / retrieved-but-unused,
  per the mechanism chosen) does not increment toward promotion.
- Unit: ranking boost applied, and a cold-tier memory with the best
  content match still wins over a hot-tier weak match below the boost cap
  (tier never gates).
- Integration (gated on `DATABASE_URL`): access accounting persists across
  two simulated sessions and produces a promotion.
- Dogfood evidence in the PR: tier distribution of this repo's own memory
  after replaying its real access history.

---

## M17 — Storage Backend: Port to SQLite (spec §25)

**Goal:** replace Postgres + pgvector + pg_trgm with a single SQLite file as
the only backend, preserving retrieval behaviour exactly. The product claim
is "your coding agent remembers why your codebase is the way it is" — today
step one of using it is provisioning a database server (spec §25.1).

This is a **behaviour-preserving port**, and that constraint is the
milestone. Anything that improves retrieval, changes semantics, or reshapes
the schema belongs to a later milestone; if the eval number moves, the port
is wrong.

- Driver: `better-sqlite3` (spec §25.2). WAL journal mode, `foreign_keys=ON`,
  a busy timeout. Database path defaults inside the repo (e.g.
  `.claude/memory.db`), no env var required to run.
- Rewrite `packages/graph-store/src/db.ts` — the only file importing `pg`
  — and the ~68 query sites behind it, per spec §25.5's construct table. No
  storage-abstraction layer: there is exactly one backend, so a `Store`
  interface would be a seam with one implementation.
- Retrieval legs per spec §25.3: FTS5 external-content table ranked by
  `bm25()`; `tokenize='trigram'` for the identifier leg; Float32 `BLOB`
  embeddings with cosine in JS and **no vector extension**. `fuseLegs()` must
  not be modified — if the port needs it changed, that is a finding to report,
  not a fix to apply.
- Delete rather than port, per spec §25.4: both `pg_advisory_lock` uses and
  the `FOR UPDATE` supersede lock, the `pg_trgm` GUC `set_config`, both
  `CREATE EXTENSION`s, CI's Postgres service, and
  `scripts/setup-dev-db.sh`'s Docker/apt detection.
- Migrations: one rewritten SQLite baseline, not a translation of 0001→0008
  (spec §25.5 decision 1). Keep the runner's applied-check contract.
- Ship a one-shot scout-report export/import (spec §25.5 decision 2) — mined
  memories are reproducible from git, scout reports are not. No other data
  migration.
- Update `CLAUDE.md`'s locked-stack rule and README's Quickstart in this
  milestone (spec §25.7) — the stack is Postgres until this lands, so those
  edits belong here and not in the proposal that authorized it.

**Acceptance:**
- The existing suite (292 tests across 12 workspaces) green on SQLite, with
  no test skipped for a missing `DATABASE_URL` — there is nothing to skip on.
- **The gate: the by-meaning eval reproduces MRR 0.85 lexical-only / 0.90
  with the stub embedder** (`BENCHMARKS.md`, M11/M15's figure). A moved
  number means a port defect; report it rather than re-baselining.
- Unit: `to_tsquery` OR-semantics preserved — a two-term question matches a
  document containing either term, ranked, not only documents containing
  both (this is the behaviour `byMeaning.ts` depends on and the reason it
  does not use `plainto_tsquery`).
- Unit: supersede serialization still refuses a cycle under concurrent
  writers, now via SQLite's write lock instead of an advisory lock — the
  test that covered the advisory-lock path must still pass on the new
  mechanism.
- Unit: `WITH RECURSIVE` supersede-chain walking, merged chains included,
  returns identical results to the Postgres implementation.
- Unit: anchor containment via `json_each`/`json_extract` still matches on
  `anchors` **OR** `related_nodes` — spec §24.7 and migration 0008 record
  that dropping the `related_nodes` leg would make this repo's own mostly
  pre-M12 corpus invisible to the staleness pass.
- Integration: tier accounting across two simulated sessions still produces
  a promotion, and no-self-promotion still holds (§24.5).
- Dogfood evidence in the PR: `sync` + `ask` against this repo on a fresh
  SQLite file — memory count, all three legs firing, staleness flags and
  their `/refine-memory <id>` next step intact — plus the on-disk size of
  the resulting `.db` against §25.1's 621 MB.
- CI runs with **no service container**, and the README quickstart is
  reduced to a `pnpm install` and a single command.

---

## M18 — Memories as Markdown, Index as Projection (spec §25.6) — DEFERRED

> **Deferred 2026-08-27 by direct human decision — do not build without
> re-deciding.** Not blocked and not refused: the cost/benefit came out negative
> once it was actually priced, and the pricing is recorded here so the next cycle
> does not re-derive it from an empty branch. Four findings, from a run that read
> the whole write path and drafted the corpus module before stopping:
>
> 1. **The gate is "MRR unchanged" (§25.6, §25.7).** By its own acceptance
>    criteria the milestone delivers no measured retrieval gain. Every other
>    shipped milestone had a number that had to move, or to hold *under
>    ablation*; this one only has a number that must not move.
> 2. **On this corpus it stores the same text twice in the same repository.**
>    All ~43 of this repo's memories are mined commit bodies
>    (`captureGitHistory` over its own history), so "git-versioned, greppable,
>    reviewable in a PR" is a property `git log --grep` already has for that
>    class. The argument survives only for **scout reports** — the one class
>    nothing can regenerate, and the one spec §25.5 decision 2 already gives a
>    portable export.
> 3. **The cost is permanent and on the write path.** Files as source of truth
>    means a write-ordering rule in `recordExperience`, `supersedeExperience`,
>    `markExperienceVerified` and `setExperienceWriterSession`; hand-edit
>    semantics to decide (does an edited observation invalidate the embedding,
>    and the `verified_at` that was claimed about the old text?); a prune guard
>    that must refuse an empty corpus; and a whole-corpus supersede-cycle check,
>    because the per-link one in `supersedeExperience` cannot see a cycle spread
>    across three files that all arrive at once.
> 4. **The measured ceiling was elsewhere.** The 2026-08-27 dogfood A/B
>    (`BENCHMARKS.md`) found the live loss was `ask` truncating each memory to 14
>    lines — 3 of 6 questions lost the deciding sentence. Five lines fixed it
>    (121baa2). Storage shape was not what cost turns.
>
> What would reopen it, named rather than left to taste: a corpus dominated by
> memories that are NOT reproducible from the host repository's own history
> (hand-authored knowledge, or scout reports outnumbering mined commits), or a
> second consumer that must read the corpus without running this CLI. Text
> preserved below for the record.

**Goal:** make the memory corpus `.md` + YAML frontmatter — git-versioned,
greppable, reviewable in a pull request — and demote SQLite to a derived,
gitignored index rebuilt from those files. **Gated on M17**: a port bug and a
redesign bug are indistinguishable if both land at once (spec §25.6).

- Memories become files: task, observation, anchors, supersedes links and
  provenance in frontmatter; body as prose. Operational state (embeddings,
  tier, `access_count`, `last_accessed`, `experience_accesses`, suspect
  flags) stays **out** of the files and lives only in the index — this is
  what makes write-on-read (§25.6) not rewrite the corpus on every `ask`.
- A `rebuild` command reconstructs the index from the files alone; deleting
  the index must never lose knowledge. Same shape as
  `packages/graph-store/src/materializer.ts`'s rebuild-from-events.
- Decide and record: what happens to a memory edited by hand in a way the
  index disagrees with (the read-repair path in §24.6 is the precedent),
  and whether a hand-edited file's `verified_at` may be trusted.

**Acceptance:**
- Deleting the index file and running `rebuild` reproduces byte-identical
  retrieval results (same ranks for the eval question set).
- A memory is findable by `grep` alone, with no CLI and no index — the
  property `E2E_BENCHMARK_MULTI_REPO.md` measured grep winning on.
- An `ask` performs no write to any `.md` file — verified by hashing the
  corpus directory before and after a query.
- The eval gate from M17 still holds: MRR unchanged.
- Dogfood: this repo's own corpus committed as markdown, with the diff of a
  real `/refine-memory` supersede readable in the PR.

---

## Sequencing note

M2 and M4 have no dependency on each other and can be built in parallel once
M1 exists. M3 depends on M4 only for its acceptance test (needs at least one
experience source), not for its core logic — build M3's promotion table
against synthetic provenance first if M4 is behind schedule.

Post-pivot (spec §24): M11 → M12 → M13 are sequential (anchors need the
shipped knowledge layer; read-repair needs anchors and staleness flags).
M14 only needs M11 and can run in parallel with M12/M13. M16 needs M11's
shipped retrieval (it hooks access accounting into it) and is independent
of M12–M15. M15 is last and gated — it starts only after M11–M12 are merged and the eval re-run shows
no regression, and it must respect M14's go/no-go either way.

That is how it played out: M15 ran after M11–M14 and M16 were all merged, its
gate passed on a re-measurement rather than on the prior recorded numbers, and
it respected M14's NO-GO by verifying there was no memory-link traversal in
`packages/` to remove or preserve.

Storage (spec §25): M17 is a behaviour-preserving port and depends on nothing
except the shipped retrieval it must not change — its gate is the M11/M15 eval
figure reproduced on the new engine. M18 is gated on M17 for the reason §25.6
gives: held constant, the eval number distinguishes a port defect from a
redesign defect; landed together, it cannot. That gating never came into play:
M18 was deferred 2026-08-27 on cost/benefit (its section note above, spec
§25.6.1), so M17's held-constant gate was the whole of §25's measurement.
Neither milestone may touch
`fuseLegs()` — a port that needs the fusion changed has found a defect to
report, not a fix to apply.
