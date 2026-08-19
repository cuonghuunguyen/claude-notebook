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
- [ ] M10 — Structural Extraction: Variable-Bound Declarations

Repo layout target:

```
spec.md
ROADMAP.md
docker-compose.yml            # local Postgres+pgvector for contributors without a local cluster
migrations/
  0001_init.sql
packages/
  core/                       # shared types (Node, Edge, Provenance, Experience) mirrored from spec.md §3-§8
  graph-store/                # Postgres client, migration runner, typed CRUD for nodes/edges/experiences/events
  structural/                 # M1: ts-morph based extractor
  retrieval/                  # M2: hybrid search (pg_trgm + pgvector) -> seed nodes
  semantic/                   # M3: promotion pipeline per spec §7
  episodic/                   # M4: experience capture/query per spec §8
  traversal/                  # M5: reasoning-guided expansion per spec §10
  context/                    # M6: subgraph -> compact agent context per spec §17
eval/                         # M7-adjacent: retrieval/staleness/promotion eval sets, spec §19
```

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

## M10 — Structural Extraction: Variable-Bound Declarations (spec §23)

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

## Sequencing note

M2 and M4 have no dependency on each other and can be built in parallel once
M1 exists. M3 depends on M4 only for its acceptance test (needs at least one
experience source), not for its core logic — build M3's promotion table
against synthetic provenance first if M4 is behind schedule.
