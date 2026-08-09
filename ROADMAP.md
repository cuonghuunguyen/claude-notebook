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
- [ ] M4 — Episodic Memory
- [ ] M5 — Reasoning-Guided Traversal
- [ ] M6 — Context Construction
- [ ] M7 — Staleness, Events, GC, Full Eval Set

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

---

## Sequencing note

M2 and M4 have no dependency on each other and can be built in parallel once
M1 exists. M3 depends on M4 only for its acceptance test (needs at least one
experience source), not for its core logic — build M3's promotion table
against synthetic provenance first if M4 is behind schedule.
