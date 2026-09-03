# Codebase Cognitive Memory — Technical Specification

Status: draft v0.2 (post-review). Structural graph is source-of-truth; semantic
graph + episodic memory sit on top; retrieval is hybrid search + reasoning-guided
traversal.

This revision folds in the fixes from the design review of v0.1: node identity
under refactors, an explicit confidence/weight split, a `disputed` edge status,
numeric promotion thresholds for semantic knowledge, a traversal batching model,
plus new sections on evaluation and garbage collection that v0.1 was missing
entirely. Anywhere this doc says "TBD" is a genuine open question, not filler.

---

## 1. Objective

Build a persistent memory layer for coding agents that represents a codebase as
a graph rather than as a collection of retrieved chunks.

The system must allow an agent to:

1. Find relevant code and concepts from a natural-language task.
2. Reconstruct relationships between relevant entities.
3. Recover architectural invariants and design decisions.
4. Recall previous debugging/fixing experiences.
5. Detect stale knowledge after code changes.
6. Expand the graph selectively using reasoning instead of blindly traversing
   neighbors.

Target data flow:

```
Task
  ↓
Hybrid Retrieval
  ↓
Seed Nodes
  ↓
Reasoning
  ↓
Selective Graph Traversal
  ↓
Evidence / Experience Retrieval
  ↓
Task-specific Subgraph
  ↓
Agent Context
```

---

## 2. Memory Model

Memory consists of three layers.

```
┌─────────────────────────────┐
│       Episodic Memory       │
│   experiences / incidents   │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│       Semantic Memory       │
│ invariants / decisions /    │
│ architecture / concepts     │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│     Structural Memory       │
│ files / symbols / calls /   │
│ imports / references        │
└─────────────────────────────┘
```

### 2.1 Structural Memory

Generated deterministically from the repository. Examples: file, directory,
module, class, function, interface, type, variable, import, export, call,
inheritance, implementation, reference, test.

Structural memory MUST NOT depend on LLM inference. Source: AST / tree-sitter,
LSP, compiler, build graph, test metadata.

**MVP scoping decision:** for the first implementation, structural extraction
covers TypeScript/JavaScript only, via `ts-morph` (a real type-checker-backed
AST, not just a parser). Multi-language support is a v2 concern, added as
additional extractors behind the same Node/Edge output contract — not a
rewrite. Full LSP integration (cross-file, cross-language call resolution) is
deferred until a single-language extractor proves the rest of the pipeline.

---

## 3. Graph Schema

### 3.1 Node

```ts
interface Node {
  id: string;            // see 3.2 Identity — stable across renames, NOT a UUID
  type: NodeType;

  name?: string;
  path?: string;

  summary?: string;

  metadata: {
    keywords?: string[];
    embedding?: number[];
    language?: string;
    package?: string;
    module?: string;
  };

  provenance: Provenance[];

  createdAt: string;
  updatedAt: string;

  status: "active" | "stale" | "deleted";
}

type NodeType =
  | "repository"
  | "directory"
  | "file"
  | "module"
  | "class"
  | "function"
  | "method"
  | "interface"
  | "type"
  | "variable"
  | "test"
  | "invariant"
  | "decision"
  | "concept"
  | "subsystem"
  | "bug"
  | "experience";
```

### 3.2 Node Identity & Versioning (new — closes review gap #1)

v0.1 had no answer for "is a renamed/moved symbol the same node or a new one?".
Without this, every semantic edge and experience pointing at a refactored
symbol silently orphans instead of being marked stale, which is exactly the
failure mode this whole system exists to prevent.

Rule:

- **Structural node id** = `hash(repo_id, stable_symbol_path)`, where
  `stable_symbol_path` is the qualified path resolved by the language tool
  (e.g. ts-morph's symbol, not the file path + line number — line numbers
  shift on every unrelated edit above the symbol).
- A **rename** the extractor's language tool can resolve as the same symbol
  (e.g. `ts-morph` rename-aware move, or a git rename with high content
  similarity) updates the existing node's `path`/`name` and bumps
  `updatedAt`. It is NOT a new node.
- A symbol the extractor cannot prove is the same one (name changed AND
  location changed AND no rename signal available) is treated as: old node →
  `status: "deleted"`; new node created. All edges from the deleted node are
  set to `status: "stale"`, not silently dropped — a stale edge is still
  retrievable evidence ("this used to be true of the old symbol"; see §14).
- Semantic/episodic nodes are never auto-merged or auto-split on rename. They
  reference structural nodes by id; if that id is deleted, the referencing
  semantic edge is marked stale per §14 and revalidated lazily.

### 3.3 Edge

```ts
interface Edge {
  id: string;

  from: string;
  to: string;

  relation: RelationType;

  confidence: number;   // 0–1: how likely this fact is TRUE
  weight: number;       // 0–1: how IMPORTANT this edge is to traversal/ranking

  provenance: Provenance[];

  status: "active" | "stale" | "invalid" | "disputed";

  createdAt: string;
  updatedAt: string;

  lastVerifiedAt?: string;
}
```

**`confidence` vs `weight` (closes review gap #2).** v0.1 defined both fields
without saying how they differ, and §13's ranking formula listed `confidence`
again as a separate term — ambiguous enough that two implementers would build
incompatible systems. The split:

- `confidence` answers *"is this true?"* — set at creation from the evidence
  hierarchy (§5) and updated only by verification (§8, §14). Structural edges
  from AST/LSP start at `confidence = 1.0` and effectively never change.
  Semantic edges start low and rise with corroboration.
- `weight` answers *"if true, how much does it matter for this traversal?"*
  — derived from usage signals independent of truth: relation type (a
  `must_follow` invariant outweighs a `references`), call frequency, fan-in/
  fan-out, how often this edge has been useful in past task contexts (fed
  back from episodic memory, §9). `weight` is recomputed periodically, not on
  every read.
- Edge ranking (§13) multiplies these together as separate factors; it does
  not conflate them into one number stored on the edge.

**`disputed` status (closes review gap #3).** v0.1's §15 said conflicting
facts get `status = "disputed"` but the Edge schema's enum didn't include it.
Fixed above. `disputed` means: two active facts about the same
`(from, to, relation)` triple disagree and the evidence hierarchy did not
cleanly resolve it (e.g. both sources are `source_code` inference with equal
confidence). A disputed edge is returned to the agent as both facts side by
side (§15), never silently collapsed to one.

Structural relations:

```ts
type RelationType =
  | "contains" | "imports" | "exports" | "calls" | "references"
  | "extends" | "implements" | "uses" | "tested_by"
  // semantic
  | "depends_on" | "owns" | "constrained_by" | "violates" | "caused_by"
  | "prevents" | "requires" | "must_follow" | "alternative_to" | "related_to"
  // experience
  | "observed_in" | "fixed_by" | "learned_from" | "relevant_to";
```

---

## 4. Provenance

Every non-trivial fact MUST have provenance.

```ts
interface Provenance {
  sourceType:
    | "source_code" | "test" | "documentation" | "git_commit"
    | "pull_request" | "agent_experience" | "llm_inference";
  sourceId: string;
  evidence?: string;
  confidence: number;
  observedAt: string;
}
```

The system must never treat an LLM-generated fact as equivalent to a
compiler-derived fact.

Evidence hierarchy (used to resolve conflicting facts, highest first):

```
compiler / AST / LSP
        >
tests
        >
source code inference
        >
documentation
        >
git history
        >
agent inference
```

**Evidence storage note (new):** `evidence` snippets pulled from source or git
history may contain secrets that leaked into code/history. Evidence text is
redacted through the same secret-scanning pass used elsewhere in the pipeline
before persistence; this is a hard requirement, not a nice-to-have, since
evidence is stored long-term and surfaced back into agent context verbatim.

---

## 5. Structural Graph Maintenance

Deterministic, incremental. On every repository change:

```
git diff
  ↓
changed files
  ↓
parse/index
  ↓
affected symbols
  ↓
recompute local relationships
  ↓
update structural graph
```

The system MUST NOT rebuild the entire graph unless explicitly requested.

For a changed file:

1. Remove obsolete structural nodes/edges belonging to the file (using
   identity rules in §3.2 — a symbol that survived the change updates in
   place, one that didn't is deleted).
2. Reparse the file.
3. Recreate/update nodes.
4. Recompute local edges.
5. Update reverse references.
6. Mark affected semantic edges as potentially stale (§14).

```
Foo.ts
  changes
    ↓
FooService node updated
    ↓
calls(FooService → BarService) recomputed
    ↓
semantic relations involving FooService
    ↓
marked stale
```

---

## 6. Semantic Memory

Semantic memory contains facts that cannot reliably be derived from syntax:

```
PaymentService --owns--> TransactionBoundary
PaymentEvent --must_follow--> DatabaseCommit
QueryRepository --constrained_by--> TenantIsolationInvariant
```

Semantic facts MAY be generated by an LLM. Every semantic fact must carry
evidence, confidence, provenance, timestamp, and affected nodes. Semantic
memory is not automatically trusted — see promotion rule in §7.

---

## 7. Semantic Knowledge Lifecycle

```
observation → hypothesis → verification → durable knowledge
```

Example: Event published before transaction commit is observed → hypothesis
that EventBus sits outside the transaction boundary → verified by inspecting
transaction config and tests → confirmed → knowledge: "PaymentEvent must be
published after DB commit."

**Promotion thresholds (closes review gap #4 — v0.1 asserted this lifecycle
with no numeric rule, which means no two runs would promote the same way):**

| Stage | Entry condition |
|---|---|
| `observation` | A single provenance record exists. Not yet an edge — stored as a candidate, not surfaced to agents. |
| `hypothesis` | ≥1 observation, `confidence < 0.5`. Surfaced to agents only if explicitly asked for low-confidence knowledge. |
| `candidate knowledge` | ≥2 observations from **at least 2 distinct `sourceType` values** (e.g. `source_code` inference + `git_commit`, or two independent `llm_inference` passes over different code paths that reach the same conclusion — repeated identical reasoning over the same evidence does not count as corroboration). `confidence` computed as evidence-hierarchy-weighted average, capped at `0.75` until verification. |
| `durable semantic edge` | Candidate knowledge that has additionally survived one explicit verification pass (§8-style: re-check the claim against current code/tests) OR has been referenced by ≥2 separate agent tasks without contradiction. `confidence` unlocked above `0.75`. |

Confidence never auto-decays to zero; staleness (§14) is the mechanism for
"this might no longer be true," not confidence decay.

---

## 8. Episodic / Experience Memory

```ts
interface Experience {
  id: string;
  task: string;
  observation: string;
  hypothesis?: string;
  action?: string;
  result?: string;
  lessons?: string[];
  relatedNodes: string[];
  confidence: number;
  timestamp: string;
}
```

Experiences are append-only and SHOULD NOT directly mutate semantic knowledge.
Instead:

```
Experience → repeated evidence → candidate knowledge → verification → semantic edge
```

(Same promotion table as §7 — an experience is just another `sourceType:
"agent_experience"` provenance record feeding that pipeline.)

---

## 9. Retrieval

```
Query
 ├── lexical search
 ├── semantic/vector search
 └── metadata filtering
          ↓
       seed nodes
```

The search layer returns nodes, not arbitrary text chunks:

```json
{ "nodeId": "payment-service", "score": 0.91, "reason": "semantic_match" }
```

**Lexical leg, concretely (closes part of review gap re: dropping
Elasticsearch):** Postgres `tsvector` full-text search is weak on code
identifiers (camelCase/snake_case, partial symbol names). The lexical leg
uses **`pg_trgm` trigram similarity** on `node.name` / `node.path`, not plain
`tsvector`, specifically because trigram similarity degrades gracefully on
partial/typo'd identifier matches the way `tsvector` does not.

**Seed set beyond top-K (closes review gap #7 — v0.1's own §13 pointed out
"a node can be a poor initial search result but extremely relevant once
reached," then didn't solve it):** the seed set is not just the top-K hits
from lexical+vector search. It also includes the **1-hop structural neighbors
of the top-3 hits** (the file containing a matched function, the interface it
implements) and the **highest-weight semantic neighbors of any matched
concept/invariant node**. This gives reasoning-guided traversal (§10) a
foothold to reach relevant-but-poorly-matched nodes without requiring the
initial search to be perfect.

---

## 10. Reasoning-Guided Traversal

Graph traversal MUST NOT blindly expand every neighbor.

```
query → seed nodes → depth = defaultDepth (2, a prior not a hard limit)
```

The reasoning agent receives: task, current nodes, available neighboring
nodes, edge types, evidence, current uncertainty — and decides `EXPAND(node,
edge)` / `SKIP(node, edge)` / `STOP`.

**Batching model (closes review gap #5 — v0.1 left it ambiguous whether
reasoning runs per-neighbor or per-frontier, which changes the cost model by
an order of magnitude):**

- Reasoning runs **once per depth level, over the entire frontier at that
  level** — not once per candidate edge. One reasoning call receives *all*
  candidate neighbors reachable from the current node set at depth *d*,
  ranked by the score in §11, and returns expand/skip/stop decisions for the
  batch.
- `maxReasoningSteps` therefore bounds **depth levels visited**, not edges
  evaluated per level — consistent with `maxDepth: 3` / `maxReasoningSteps: 5`
  coexisting with `maxNodes: 50` in the budget below: 5 reasoning calls can
  each emit many EXPAND decisions and still land under 50 total nodes.
- The frontier passed to a reasoning call is pre-filtered and capped (e.g.
  top 15 candidates by §11 score) before it reaches the LLM — the reasoning
  step chooses among a curated shortlist, it does not evaluate every
  raw neighbor in the database.

```
PaymentService
 ├── calls → PaymentRepository       EXPAND
 ├── emits → PaymentEvent             EXPAND
 ├── imports → DateFormatter          SKIP
 └── documented_by → README           SKIP
```

### 10.1 Traversal Budget

```ts
interface TraversalBudget {
  maxDepth: number;
  maxNodes: number;
  maxEdges: number;
  maxReasoningSteps: number;
  maxTokens: number;
}
```

Default: `maxDepth: 3, maxNodes: 50, maxEdges: 100, maxReasoningSteps: 5`.

Stop when: required information is sufficient, OR budget exhausted, OR
marginal relevance becomes too low.

---

## 11. Edge Ranking

```
score = semantic_relevance + relation_importance + node_importance
        + confidence * weight + task_relevance + freshness - traversal_cost
```

`confidence` and `weight` enter as a product (§3.3), not two independent
additive terms — a high-importance but low-confidence edge and a
high-confidence but low-importance edge should not score identically, which
additive combination would allow.

Search relevance ≠ graph traversal relevance (see §9's seed-expansion fix).

---

## 12. Staleness

States: `active`, `stale`, `invalid` (edge status also has `disputed`, §3.3).

```
source change → affected structural nodes → dependent semantic edges → mark stale
```

Do NOT eagerly verify every stale edge. Lazy verification:

```
stale edge retrieved → verify against current code → valid: refresh | invalid: invalidate
```

---

## 13. Conflict Resolution

```
Fact A: confidence 0.8, source = source_code
Fact B: confidence 0.95, source = llm_inference
→ Fact A wins (source reliability beats raw LLM confidence)
```

If conflict cannot be resolved by the hierarchy: `status = disputed`. The
agent receives both facts, not a silent choice.

---

## 14. Graph Materialization

The graph is a projection over persistent events:

```
Events → Graph Materializer → Structural Graph / Semantic Graph / Experience Index
```

Events: `CodeChanged, SymbolAdded, SymbolRemoved, RelationAdded,
RelationInvalidated, InvariantLearned, DecisionRecorded, ExperienceRecorded,
ExperiencePromoted`.

This allows the system to rebuild or repair the graph from the event log.

---

## 15. Update Pipeline

Normal code change: `commit → diff → structural extraction → graph update →
affected semantic edges marked stale`.

Agent task: `task → retrieve seeds → reason → traverse → retrieve experiences
→ construct context → agent executes task`.

After task: `transcript → extract experiences → link to nodes → store
episodic memory → optionally propose semantic knowledge → verify → promote`.

---

## 16. Storage (MVP)

v0.1 offered Elasticsearch + vector DB + graph DB as the "proper" architecture
and a single Postgres as the MVP fallback. This spec commits to the MVP path
until a measured bottleneck justifies splitting out a dedicated engine —
see §19 (Eval Plan) for what "measured" means:

```
Postgres
  ├── nodes, edges, experiences, evidence, events   (relational tables)
  ├── pgvector column on nodes.embedding            (vector search, HNSW index)
  └── pg_trgm index on nodes.name / nodes.path       (lexical search, §9)
```

Recursive CTEs handle traversal (§10) up to `maxDepth`. The traversal loop
fetches one full frontier per depth level via a single CTE query (batched to
match §10's reasoning-batching model), not one query per neighbor — the two
decisions are the same shape and must be implemented together or the DB
round-trip count defeats the point of batching the reasoning calls.

Graph-DB / Elasticsearch split is deferred, not rejected — see §19.

---

## 17. Context Construction

The final context given to the coding agent is not the raw graph — it's a
compact, task-specific projection: relevant subsystem, important
relationships, invariants, prior experience, relevant source files. The graph
is an intermediate representation; the LLM receives a compressed view of it.

---

## 18. Garbage Collection & Retention (new — closes review gap re: unbounded growth)

v0.1 had no answer for what happens to `status: "deleted"` nodes, `invalid`
edges, or the append-only experience log over time. Left unaddressed, storage
and embedding-index cost grow without bound and query performance degrades.

- **Deleted structural nodes**: retained for 90 days after `status:
  "deleted"` (so stale-edge lazy verification and "this used to exist"
  queries still work), then hard-deleted along with their edges in a batch
  job. Their id is never reused (hash-based, §3.2, so no collision risk
  either way).
- **Invalid edges**: hard-deleted after 30 days in `invalid` status — once
  invalidated there's no retrievable value in keeping them, unlike deleted
  nodes.
- **Experience log**: never deleted, but only experiences referenced by an
  active node AND not yet superseded by a promoted semantic edge stay in the
  hot vector index. Experiences whose lessons were promoted to durable
  semantic edges (§7) are moved to cold storage (still queryable, not part of
  default retrieval) — the semantic edge is now the fast path to that
  knowledge.
- **Embeddings**: recomputed only on node content change, not on a schedule;
  orphaned embedding rows (node hard-deleted) are cleaned up in the same
  batch job as node GC.

---

## 19. Evaluation Plan (new — closes review gap re: no way to know if this works)

v0.1 specified the mechanism but never how to tell if it's working — for a
system whose entire value proposition is "trustworthy retrieval," that's not
optional. Minimum bar before this is considered validated, not just built:

1. **Retrieval eval set**: a hand-labeled set of (task description → expected
   seed nodes, expected final subgraph) pairs, built from real past tasks in
   this repo. Track precision/recall of seed nodes and of the final subgraph
   separately — traversal can recover from a mediocre seed set (§9), so the
   two numbers measure different things.
2. **Staleness accuracy**: inject known refactors (rename, delete, move) into
   a test copy of the repo, confirm the expected edges flip to `stale` and no
   unrelated edges do.
3. **Promotion correctness**: seed the experience log with synthetic
   corroborating/contradicting observations, confirm the §7 table promotes
   and blocks promotion exactly where the thresholds say it should.
4. **Traversal cost**: track nodes/edges/reasoning-calls actually consumed
   per task against the budget (§10.1) — if tasks routinely hit
   `maxReasoningSteps` without reaching STOP naturally, the default budget or
   the ranking function (§11) needs tuning, not a bigger budget.

This eval set is a build milestone (see `ROADMAP.md`), not a someday-nice-to-have.

---

## 20. Core Design Principle

```
Code                    ──deterministically──> Structural Graph
Code + Tests + History  ──reasoning──────────> Semantic Graph
Agent Tasks              ──experience─────────> Episodic Memory
Query                    ──retrieval──────────> Seed Nodes
Seed Nodes               ──reasoning──────────> Relevant Subgraph
Relevant Subgraph        ──compression────────> Agent Context
```

Invariant: **the graph stores relationships; retrieval discovers where to
look; reasoning decides what relationships matter; evidence determines
whether the relationship can be trusted.**

---

## 21. Multi-Language Structural Extraction (extends §2.1 — proposed via `/propose-milestone`)

§2.1's MVP scoping decision named TypeScript/JavaScript via `ts-morph` as
the first structural extractor and explicitly deferred multi-language
support until "a single-language extractor proves the rest of the
pipeline" — not rejected, deferred pending that condition. `ROADMAP.md`'s
M1–M7 have since shipped and validated that full pipeline end-to-end
(structural graph, semantic promotion, episodic memory, hybrid retrieval,
reasoning-guided traversal, context construction, staleness/GC) against
the TS/JS extractor. §2.1's stated condition for lifting the deferral has
been met.

**What this section decides:** additional per-language structural
extractors are a legitimate extension of §2.1, not a new subsystem —
each one MUST conform to the SAME contract §2.1 already committed to
("added as additional extractors behind the same Node/Edge output
contract — not a rewrite"):

- Emit `sourceType: "source_code"` provenance at `confidence: 1.0`, same as
  the TS/JS extractor (§4) — structural facts from any language's own
  AST/type-checker tooling are equally deterministic and equally trusted.
- Compute node identity as `hash(repoId, stableSymbolPath)` per §3.2, where
  `stableSymbolPath` is resolved by that language's own AST/symbol-
  resolution tool (not file path + line number) — the same stability
  requirement §3.2 already states, just resolved by a different tool per
  language.
- Support the same incremental-update contract as §5: given a changed-files
  list, only that language's affected files are reparsed, and only their
  nodes/edges are written — identical shape to M1's incremental mode, not a
  parallel mechanism.
- Structural nodes/edges from every language extractor share one graph;
  cross-language edges (e.g. a TS module calling into a Python service
  boundary) are out of scope for a single additional-language extractor and
  remain a `related_to`-style semantic fact (§6), not a structural one,
  until a concrete cross-language linking mechanism is specified.

**What this section deliberately does NOT decide:** which parsing/
type-resolution library backs the first additional language extractor.
§2.1 named `ts-morph` specifically because it is type-checker-backed, not
just a parser; an equivalent choice for a second language is a new
dependency this spec does not pre-commit to — the same posture §9 already
takes with the embedding provider ("an injected interface, not
hardcoded"). Picking that library is an implementation decision for
whoever builds the milestone below, not a spec-level commitment, and per
`CLAUDE.md`'s locked-stack rule it is a decision a human should confirm
before it's added, not something a milestone build silently introduces.

Multi-language structural extraction is a build milestone (see
`ROADMAP.md`), not a someday-nice-to-have — the same posture §19 takes
toward the eval plan.

---

## 22. Pipeline Orchestration (extends §1, §9, §10, §17 — proposed via `/propose-milestone`) — its INTERFACE is superseded by §24.7 item 9; the composition principle stands

> **Read §24.7 item 9 before treating anything below as current.** M15 removed
> §9's node retrieval and §10's traversal, so the seven-step composition,
> `PipelineOptions`'s required `graph`/`reasoner`, and `PipelineResult`'s
> `seeds`/`traversal` fields specified in this section no longer exist in the
> code. What survives is this section's actual argument — that the stages must
> be composed *somewhere* rather than left to each caller — and
> `packages/pipeline` still is that somewhere. The stage list is what changed.


§1's data-flow diagram (Task → Hybrid Retrieval → Seed Nodes → Reasoning →
Selective Graph Traversal → Evidence/Experience Retrieval → Task-specific
Subgraph → Agent Context) and §15's "Agent task" pipeline sketch describe
the system's core value proposition as one continuous flow. M2 (retrieval),
M5 (traversal), and M6 (context) each independently implement one stage of
that flow, but **no code in the workspace composes them** — `retrieveSeeds`
(§9), `traverse` (§10), and `buildContext` (§17) have zero dependency edges
between their packages, and their types don't compose: `retrieveSeeds`
returns `SeedNode[]` where `traverse` expects `seedNodeIds: string[]`, and
`traverse` returns `TraversalResult` (`{ nodeIds: string[], edges }`) where
`buildContext` expects a `Subgraph` (`{ nodes: Node[], edges }`) — there is
no hydration step anywhere turning traversal's id list into the hydrated
nodes context requires. A caller today can exercise any one stage but
cannot go from a task string to an `AgentContext` without first writing the
composition layer this section specifies. (§21's claim that M1–M7
"validated th[e] full pipeline end-to-end" refers to each stage's own
fixtures, not a cross-package integration path — no such path exists prior
to this section.)

**What this section decides:** a new package composes the existing M2/M5/M6
contracts, unmodified, into one entry point:

```ts
interface PipelineOptions {
  repoId?: string;
  /** Shared with both retrieval's vector leg and traversal's ranking term —
   *  computed at most once per call (see below), never independently by
   *  each stage, so the two stages can't disagree about what "semantically
   *  relevant to this task" means for the same call. */
  embedder?: EmbeddingProvider;       // retrieval §9
  graph: GraphProvider;               // traversal §10 — required, no default
  reasoner: ReasoningProvider;        // traversal §10 — required, no default
  retrieveOptions?: Omit<RetrieveOptions, "embedder" | "repoId">;
  traverseOptions?: Omit<TraverseOptions, "graph" | "reasoner" | "taskEmbedding">;
  contextOptions?: BuildContextOptions;
  /** Flat cap on hydrated experiences across the whole subgraph, independent
   *  of node count — keeps this bounded the same way §17's own
   *  DEFAULT_MAX_* caps bound buildContext's output. Default 20. */
  maxExperiences?: number;
}

interface PipelineResult {
  context: AgentContext;   // §17
  seeds: SeedNode[];       // §9 — surfaced for callers/eval harnesses that need to see *why*
  traversal: TraversalResult; // §10 — ditto
}

function runPipeline(task: string, options: PipelineOptions): Promise<PipelineResult>;
```

Composition steps, in order:

1. If `options.embedder` is set, call `embedder.embed(task)` once and reuse
   the result for both retrieval's vector leg (via `retrieveOptions`
   plumbing into §9's `RetrieveOptions.embedder`) and traversal's
   `taskEmbedding` (§10's §11-ranking term) — one embedding call per
   `runPipeline` invocation, not one per stage.
2. Call `retrieveSeeds(task, { repoId, embedder, ...retrieveOptions })` →
   `SeedNode[]`.
3. **Empty-seed case (previously undefined):** if retrieval returns zero
   seeds, skip traversal entirely and return `buildContext({ nodes: [],
   edges: [], experiences: [] }, task, contextOptions)` — an empty but valid
   `AgentContext`, never a thrown error. A task nothing in the graph matches
   yet is a legitimate outcome (e.g. a brand-new codebase), not a failure.
4. Otherwise call `traverse(seeds.map(s => s.nodeId), task, { graph,
   reasoner, taskEmbedding, ...traverseOptions })` → `TraversalResult`.
5. Hydrate nodes: `getNodesByIds(traversalResult.nodeIds)` (graph-store,
   already exported) → `Node[]`.
6. Hydrate experiences: `queryByNode(node.id)` (episodic, already exported)
   for each hydrated node, de-duplicated by experience id, truncated to
   `maxExperiences` most-recent — this is the §9/§17 "Evidence/Experience
   Retrieval" stage, which nothing previously invoked outside test
   scaffolding (`recordExperience` had no non-test caller; this section
   doesn't change that write side, only exercises the existing read side).
7. Assemble `Subgraph = { nodes, edges: traversalResult.edges, experiences
   }` and call `buildContext(subgraph, task, contextOptions)` → `AgentContext`.

**What this section deliberately does NOT decide:** §15's "after task"
step (transcript → extract experiences → `recordExperience` → promote,
§7/§8) stays out of `runPipeline`'s scope. That step necessarily happens
*after* the agent has acted on the context this section produces —
potentially in a different process entirely — so it remains the caller's
own later call to the existing `recordExperience` API (§8), not something
this orchestration entry point can perform synchronously. This section
covers exactly §1's diagram from `Task` through `Agent Context`, not the
loop back into episodic memory.

No new external dependency is introduced — `runPipeline` composes
already-exported functions from `retrieval`, `traversal`, `graph-store`,
`episodic`, and `context` (§9/§10/§17/§8), using the same injected-provider
pattern (`EmbeddingProvider`, `GraphProvider`, `ReasoningProvider`) those
sections already established. Node/edge semantics (§3.2, §3.3), the
promotion table (§7), and traversal batching (§10) are unmodified; this
section only wires existing contracts together.

Pipeline orchestration is a build milestone (see `ROADMAP.md`), not a
someday-nice-to-have — the same posture §19 and §21 take.

---

## 23. Structural Extraction: Variable-Bound Declarations (extends §2.1, §5 — proposed via `/propose-milestone`) — SUPERSEDED by §24, never built

§2.1 names `variable` as a structural node type and commits the TS/JS
extractor to covering "file, directory, module, class, function, interface,
type, variable, import, export, call, inheritance, implementation,
reference, test" — but M1's implementation (`packages/structural/src/extract.ts`)
only ever walks `sourceFile.getFunctions()` (function declarations) and
`sourceFile.getClasses()` (class declarations). A module-level
`const`/`let`/`var` declaration — whether it holds a function value, a
factory-produced object, or a plain literal — produces no node at all,
regardless of §2.1's stated scope.

**Demonstrated, not asserted:** the real-world benchmark added in
`eval/e2e-benchmark/` (see `E2E_BENCHMARK_REPORT.md`, run against zod v4's
`packages/zod/src/v4/{classic,core}` — 29 files, ~42,000 lines, a real,
popular library unrelated to this repo's own fixtures) measured this gap
directly:

- Ingest produced 326 `function` nodes but only 6 `class` nodes from 42k
  lines of code, because zod v4 defines nearly all of its schema
  constructors via `export const ZodString = $constructor("ZodString", ...)`
  — a call-expression-initialized `const`, not an ES6 `class` declaration —
  and its helper functions are frequently `export const foo = (...) => {...}`
  arrow functions, not `function` declarations.
- 2 of 12 hand-labeled retrieval questions ("where's the email validation
  regex" / "where's the error map defined") failed with **zero** hits,
  full stop — not a ranking problem, a coverage problem: the ground-truth
  files (`regexes.ts`, `errors.ts`) consist entirely of `export const`
  bindings, so the graph contained no node representing their content at
  all for retrieval or traversal to ever reach.

**Consistency check:** this section only adds node emission for a
declaration kind M1 already scoped in §2.1 but never implemented — it does
not touch node identity (§3.2), confidence/weight (§3.3), the promotion
table (§7), or traversal batching (§10). Every node this section adds
carries `sourceType: "source_code"` provenance at `confidence: 1.0`, same
as every other M1/§21 structural node — no LLM inference, no new
provenance tier.

**What this section decides:** the TS/JS extractor additionally walks each
source file's **module-level** `VariableDeclaration`s (declarations nested
inside a function/block body are out of scope, same MVP-scoping posture
§2.1 already takes with `getFunctions()`/`getClasses()`'s top-level-only
reach) and emits one node per declaration, per its initializer:

- **Initializer is a function-like expression** (arrow function or function
  expression) — emit a `function` node. Structurally this binding IS a
  function; nothing is inferred. It participates in call resolution
  exactly like a `function`-declaration node (§5's existing call-edge
  pass): a call into `export const add = (a, b) => a + b` resolves a
  `calls` edge the same way a call into `function add(a, b) {}` already
  does.
- **Any other initializer** (call expression / factory pattern, object,
  array, literal, template, etc.) — emit a `variable` node. This is
  deliberately the least-inferential choice available: a call expression
  like `$constructor("ZodString", ...)` MIGHT play the architectural role
  of a class in the source library's own design, but structural extraction
  "MUST NOT depend on LLM inference" (§2.1) to make that judgment — calling
  it a class would be a semantic claim (§6), not a structural fact. Later
  layers (§6 semantic memory, e.g. an LLM-proposed `related_to`/`owns` fact
  observing "this variable is used like a class") can add that
  interpretation on top of the structural `variable` node this section
  guarantees exists; structural extraction's job is only to guarantee it
  exists at all, which today it does not.

Both kinds get a `contains` edge from their containing file node, identical
in shape to every existing M1 node/edge. Node identity is unchanged —
`hash(repoId, stableSymbolPath)` per §3.2 — with a new `stableSymbolPath`
shape for this declaration kind: `function`-typed variable bindings reuse
the existing shape-fingerprint identity strategy (name-independent, so a
plain rename keeps the same id), generalized to arrow functions/function
expressions the same way it already covers `FunctionDeclaration`/
`MethodDeclaration`; `variable`-typed bindings use an analogous
initializer-fingerprint (hashing the initializer expression's text,
excluding the binding's name) so the same "rename survives, changing the
value doesn't" contract §3.2 established for functions applies to plain
variables too.

**What this section deliberately does NOT decide:** whether the same gap
exists in the Python extractor (§21) — the evidence above is TS/JS-only
(a real TS/JS library). Whether Python's `def`/`class`-only coverage has an
equivalent module-level-binding gap is a separate question for a separate
proposal if and when it's similarly demonstrated, not assumed here.

Variable-bound declaration extraction is a build milestone (see
`ROADMAP.md`), not a someday-nice-to-have — the same posture §19, §21, and
§22 take.

---

## 24. Knowledge-First Pivot (supersedes §23; amends the weight of §2.1, §5, §10 — direct human decision, 2026-08-19)

This section records a direction decision made directly by the project's
human owner, not via `/propose-milestone` — so the evidence bar it must meet
is the one it cites, not a self-merge rule.

### 24.1 The evidence

Two measurements of the same shipped system, on two different jobs:

- **Code location** (`E2E_BENCHMARK_MULTI_REPO.md`): the structural graph
  loses to a naive grep baseline on both benchmark repos in every regime,
  including multi-hop — the regime graph traversal was designed for
  (lodash multi-hop: 0.36 vs 0.43 recall). The earlier "beats grep at
  ranking" claim was a measurement artefact.
- **Recorded reasoning** (`WHY_MEMORY_SPIKE.md`): memories of *why* —
  design decisions, reverts, debugging outcomes mined from git history —
  cut agent work from 7.7 to 1.4 mean turns (−82%) at −47% cost against a
  baseline agent with full git access. Retrieval that reaches experiences
  **by their own content** scored MRR 0.75; the shipped path that gates
  experiences behind structural-node hits scored 0.13.

Conclusion drawn: the product is the knowledge layer. The structural graph
is not the value; at most it was a coordinate system for anchoring
knowledge — and a cheaper coordinate system exists (§24.3).

### 24.2 What this decides

1. **The knowledge layer is the product surface.** Capture and by-meaning
   retrieval (hybrid text + embedding search over experience content, not
   node-gated) move from scripts/spikes into `packages/`. Capture has two
   source classes, covering *why*, *what*, and *how* alike:
   - **Git-history mining** (the why-spike method): design decisions,
     reverts, debugging outcomes — knowledge not present in the source.
   - **Agent-session distillation**: the synthesized understanding an agent
     builds while scouting a codebase before a task — subsystem maps,
     how-X-works walkthroughs, gotchas — recorded at task end so the next
     session doesn't re-spend those turns.
   Guardrail on the second class: store **synthesized understanding, not
   bare locations**. "X lives in file Y" is a question grep answers in one
   turn (measured — `E2E_BENCHMARK_MULTI_REPO.md`); persisting it buys no
   turns and adds staleness risk. What/how memories are also the
   fastest-rotting class, which is precisely what §24.2.3–4 (git-driven
   staleness + read-repair) exist to absorb. (ROADMAP M11.)
2. **Anchors are plain text**: `{ path, symbol? }` — file path plus
   optional symbol name as text. Never line numbers (they rot on every
   edit above them). A moved symbol is re-found lexically at read time.
   (M12.)
3. **Staleness is git-driven, not AST-driven**: a commit touching a
   memory's anchored paths marks it suspect; at retrieval, a memory older
   than the last commit touching its anchors is flagged
   `possibly-stale — verify`, still returned, never silently dropped.
   Repair happens at read time (§24.2.4), not by background rescans.
   (M12.)
4. **Read-repair with supersedes chains**: a refine step re-checks a
   retrieved memory against the current code/history and, if stale, writes
   a corrected memory superseding the old one. Retrieval returns chain
   heads by default. This is the update path §7/§13 wanted, relocated to
   the moment of use. (M13.)
5. **Graph traversal moves up one level — pending proof.** Code-symbol
   edges (calls/imports) lost to grep because grep can reconstruct them
   from source. Edges *between memories* (revert references, shared
   PR/issue, temporal follow-ups on the same files) exist nowhere in the
   source — that is the only traversal hypothesis still standing, and it
   ships only if a measured spike moves a number. (M14, go/no-go.)
6. **The structural graph is slated for decommission** once nothing
   load-bearing reads it — gated on the above landing without regression,
   not on enthusiasm. (M15.)
7. **Language-agnosticism is a design principle, not a side effect.**
   Every mechanism above — git-history mining, text anchors, commit-
   triggered staleness, supersede chains, memory-link edges — works
   identically for any language (and for SQL, YAML, infra, docs). Parsing
   does not: each language costs its own extractor forever (M1 ts-morph,
   M8 tree-sitter, an unbuilt M10, …) and the coverage frontier never
   closes. This, alongside the benchmark evidence, is an independent
   reason the pivot removes parsing from the load-bearing path: nothing in
   §24 may reintroduce a per-language dependency.

### 24.3 What §23 got wrong (and why it dies)

§23 read the zod zero-hit failures as a node-coverage gap and prescribed
more extraction. The why-spike showed the winning retrieval path never
routes through node hits at all — the correct fix for "the graph has no
node for `errors.ts`" is retrieval that doesn't need one. With anchors as
plain text (§24.2.2), extending node coverage buys nothing a text anchor
doesn't already provide. §23 is therefore superseded unbuilt; its evidence
(the zod measurements) remains valid and is answered by M11 instead.

### 24.4 What survives unchanged

The three-layer intent of §2 survives; what changes is which layer is
load-bearing. §3.3 (confidence vs weight), §7 (promotion thresholds), §8
(episodic memory), §13 (conflict resolution — now realized as supersedes
chains), §18 (GC) all stand. §3.2's node-identity machinery stands for as
long as structural nodes exist (until M15) but new knowledge binds to text
anchors, not node ids. §9's hybrid-search shape is reused, pointed at
experience content. §10's traversal batching applies to memory-link
traversal if and only if M14's spike returns "go".

### 24.5 Memory Tiers: Access-Driven Promotion (extends §7, §11, §18 — human-directed, 2026-08-19)

Memories live in three tiers — **short-term → mid-term → long-term** — and
move between them based on real access, extending §7's promotion lifecycle
(evidence-driven) with a usage-driven axis, and giving §18's GC its
retention signal.

- Every retrieval hit records `access_count` / `last_accessed` /
  `distinct_sessions` on the memory (write-on-read, cheap).
- **Capture lands in short-term.** Promotion to mid-term when a *different*
  session than the writer retrieves and uses it; promotion to long-term on
  sustained access across multiple distinct sessions/tasks. Exact numeric
  thresholds are set at milestone time from eval data, in the same style
  §7 fixed its promotion numbers — but the shape (distinct-session counts
  over a time window, not raw hit counts, so one chatty session can't
  self-promote a memory) is decided here.
- **Demotion is decay**: no access within a tier-specific window drops the
  memory a tier; an unaccessed short-term memory becomes a §18 GC
  candidate. Long-term demotes but is never GC'd solely for coldness.
- **Tier is a ranking boost, not a gate**: by-meaning search (§24.2.1)
  always spans all tiers; tier feeds the §11 ranking function as a score
  multiplier. Retrieval must never miss a correct cold memory outright —
  it may only rank it lower.
- **Synergy with read-repair (§24.2.4)**: promotion is triggered by the
  same event (retrieval) that triggers verification, so the hot tier is
  also the freshest tier by construction; the cold tail is handled by
  decay/GC rather than repair effort.
- **DECIDED (M16) — access is not correctness.** A plausible-but-wrong
  memory that keeps getting retrieved would climb tiers on raw access
  counts, and the tier boost would then make it climb faster — a feedback
  loop whose endpoint is the memory layer's most confident answers being
  its wrongest ones. The promotion signal is therefore *useful* access,
  never mere retrieval. Of the three candidates §24.5 originally listed,
  M16 ships **candidates 2 and 3 composed** — task outcome as the negative
  signal, reported use as the positive one. Neither alone is sufficient, and
  the measurement below shows why candidate 2 by itself is not:
  1. **Verification-gated promotion** — an access counts only if
     read-repair (§24.2.4) verified the memory fresh at that access.
     *Not shipped in M16 because read-repair is M13 and not built yet.*
     Rejected on availability, not on merit: when M13 lands, a stale
     verdict becomes one more reason to settle an access `rejected`, which
     needs no schema change.
  2. **Task-outcome feedback** — **SHIPPED, as the negative half.** The
     quality gate (`.claude/hooks/quality-gate.sh`) records a real pass/FAIL
     verdict per finished task. A **failed** task settles every memory it
     retrieved `rejected`: the task had that context and still went wrong,
     so none of it earns credit, and no claim is needed about which member
     was at fault. A **passed** task, on its own, credits nothing — see
     below, and see the measurement, which is what forced that asymmetry.
  3. **Used-vs-ignored signal** — **SHIPPED, and REQUIRED for any
     promotion.** `settleSession`'s `usedExperienceIds` names the memories
     the session relied on; only those are `confirmed`. Everything else the
     session retrieved settles `unused` — neutral, not negative, because
     "the caller did not say" is not evidence against a memory.

  **The two are composed, not alternatives, and the composition is
  asymmetric on purpose.** Failure is broad (it discredits the whole
  retrieved set); success is narrow (it credits only what was cited). The
  measurement below is what settled this: a rule that credits everything a
  *passing* task retrieved scores identically to raw access counting,
  because a pass/fail verdict describes the task, not each memory the task
  happened to retrieve — and most tasks pass. Composing outcome with
  citation is what makes the signal informative.

  **Fail-closed, twice.** Nothing promotes until an outcome is reported (an
  abandoned session leaves its accesses `provisional` forever), and nothing
  promotes unless the caller names it as used. "A good memory promotes once
  someone reports relying on it" is a strictly cheaper failure than "a
  wrong memory promotes because the tests were green for unrelated
  reasons".

  **The unit is the (memory, session) pair**, enforced as the primary key
  of `experience_accesses` rather than as an assertion — which is what
  makes "one chatty session cannot self-promote a memory" a property of the
  data model *for a single caller reusing one honest session id*. An access
  by the memory's own writer session settles `self`: neutral forever,
  because a session that writes a memory and reads it back has corroborated
  nothing.

  **Trust boundary — the PK is not a security control.** `session_id`, the
  reported outcome, and the accessed-id list are all caller-supplied and
  unverified, and `applyTierDecisions` is directly callable. Three fabricated
  session ids will move any memory to long-term. The accounting is designed
  against *accident* — a chatty process, a self-read, a task that failed —
  not against a hostile caller, and the primary key should not be read as
  doing more than that. Anything stronger needs an authenticated notion of a
  session, which this system does not have and §24.5 does not introduce.

  **Thresholds** (stated, §7-style, so two runs promote identically):
  short → mid at **1** confirmed distinct session, mid → long at **2**
  more earned *after* reaching mid (three in total), counted only inside a
  **90-day** sustained-access window and only from accesses settled
  strictly after the memory entered its current tier. Requiring fresh
  credit per tier is what stops one confirmation being counted twice, and
  what stops an idle-demoted memory being re-promoted by its own ancient
  credit on the next maintenance pass. Decay windows are 30/90/180 days
  for short/mid/long; 3 rejected sessions since the last confirmation cost
  a tier.

  **Measured justification** (`eval/tier-promotion`). Three promotion rules
  run over one workload, through the same policy function and the same
  thresholds; the only variable is which accesses earn credit. A labelled
  subset of the corpus is plausible-but-wrong, and the outcome signal is
  deliberately **noisy in both directions** — a wrong memory relied on still
  passes its task 30% of the time, and 10% of clean tasks fail anyway —
  because a model where task outcome perfectly predicts memory correctness
  would make the result arithmetic rather than evidence. The metric is
  *precision*, because §24.5's costs are asymmetric: a sound memory left cold
  is merely ranked lower, while a wrong memory in long-term is boosted into
  every future answer.

  | rule | tier distribution | boosted precision | wrong memories boosted | sound boosted |
  |---|---|---|---|---|
  | raw retrieval counting | short 0%, mid 1.8%, long 98.3% | 0.887 | 45 | 355 |
  | task passed (broad) | short 0.3%, mid 5.3%, long 94.5% | 0.887 | 45 | 354 |
  | task passed + reported use (**shipped**) | short 53.3%, mid 25.5%, long 21.3% | **0.968** | **6** | 181 |

  400-memory corpus, 669 sessions, 45 plausible-but-wrong memories.

  **The middle row is why the design changed.** Crediting everything a
  *passing* task retrieved is gated, looks principled, and is statistically
  indistinguishable from not gating at all — identical precision, the same 45
  wrong memories boosted, and 94.5% of the corpus in long-term. The reason is
  structural: a pass/fail verdict is a property of the task, not of each
  memory the task happened to retrieve, and most tasks pass. So a rule built
  on it alone is raw access counting wearing a gate's clothes — the exact
  failure ROADMAP M16 calls an automatic review failure, reached by a
  different route. Requiring the caller to *name* what it relied on cuts wrong
  promotions from 45 to 6 and empties long-term of them entirely.

  **What this does NOT establish**, stated plainly because the shipped rule's
  precision is 0.968 and not 1.000: a wrong memory that is genuinely relied on
  while the tests stay green still earns credit. Outcome-plus-citation is a
  strong filter, not a correctness oracle, and no signal available in this
  system today is one. Candidate 1 (verification-gated, needs M13's
  read-repair) is the one that would attack that residue directly, which is
  why it is recorded above as deferred on availability rather than rejected.

  **And a caveat on the corpus.** The 400-memory figures are synthetic. Re-run
  over this repository's own mined history the corpus is 27 memories, which is
  too small for a precision estimate; what that run does establish is that the
  shipped `recordRetrievalAccess` + `settleSession` path reproduces the
  `narrow` arm's predicted tier distribution exactly, i.e. the measurement
  describes the code that shipped rather than a model of it. The retrieval
  *workload* in both runs is modelled, not replayed from real traffic — no
  real access history exists yet, because nothing in the harness reports a
  session's outcome (see the deployment note below).

  **Deployment status (be explicit about this).** The write-on-read half is
  wired into `queryByMeaning`, and the promotion half is inert until some
  caller reports outcomes with citations: with no `usedExperienceIds`
  producer, every access settles `unused` and nothing is ever promoted. That
  is the intended fail-closed default, not a bug — but it means M16 ships the
  tier machinery, the ranking boost, decay, and the schema, with promotion
  waiting on a citation producer in the agent harness.

- **Relation to bi-temporal designs (Zep/Graphiti)**: deliberately not
  adopted wholesale. Supersede chains + `created_at`/`superseded_at`
  timestamps already answer "what did we believe at time X" by walking a
  chain; tiers answer the different question bi-temporality doesn't —
  what is worth keeping and ranking up. (ROADMAP M16.)

### 24.6 Read-Repair Mechanics (realizes §24.2 decision 4 — ROADMAP M13)

§24.2 decision 4 fixed the semantics: "a refine step re-checks a retrieved
memory against the current code/history and, if stale, writes a corrected
memory superseding the old one. Retrieval returns chain heads by default."
This section records the four choices M13 had to make to build that, so
they are decided rather than re-derived. It extends §24.2.3 and realizes
§13's conflict resolution; it relitigates nothing.

1. **The link points forward: `superseded_by` on the retired memory.**
   Not `supersedes` on the correction. Both express the same relation, but
   the question on the hot path is "is this row still the current answer?",
   asked of every candidate row in three search legs. Forward, that is a
   null test on the row already being scanned; backward, it is an anti-join.
   A single forward column also makes chains non-forking by construction —
   one memory, one successor, one column to name it in — so "chain head"
   is well defined as `superseded_by IS NULL` without a uniqueness
   constraint.

2. **Superseded memories are excluded from ALL default retrieval, not just
   by-meaning.** By-node, by-task and the three search legs share one
   visibility predicate with §18's cold rule. A retracted memory still
   reachable through a side door is retracted in name only — and by-node /
   by-task are what `runPipeline` and the promotion pipeline read. History
   stays queryable by explicit opt-in (`includeSuperseded`) and by walking
   a chain from any member; nothing is deleted, ever.

3. **Verification is an instant, not a flag.** §24.2.3's staleness verdict
   is *recomputed from git at read time* as well as persisted at sync
   time, so read-repair's "I checked; it is still accurate" outcome cannot
   be expressed by clearing `suspect`: the commit that raised the flag
   stays newer than the memory's write instant forever, and the next read
   re-derives the identical verdict. A memory therefore carries
   `verified_at`, and the staleness test measures from
   `max(timestamp, verified_at)`. This is not suppression — commits made
   after the verification flag the memory again, which is the point.

4. **A supersede is eventful; a verification is not.** §14's event log
   gains `ExperienceSuperseded`. The test applied is what a
   rebuild-from-events would do without it: dropping a supersede link puts
   *retracted knowledge back into the default retrieval path*, so the
   rebuilt graph answers questions with claims the system has withdrawn.
   Dropping a `verified_at` merely re-raises a flag, which is conservative
   and self-healing — the same test `cold` (§18) and `suspect` (§24.2.3)
   already fail, and the reason neither of them is eventful either.

**Where repair happens is unchanged from §24.2.3: at read time, driven by
a caller.** There is no background refine pass and none is planned. The
step only has the information it needs when something is actually reading
the code the memory describes, and M12's measured 24-of-27 flag rate on
this repository means an unattended pass would be mostly rewriting
memories that were never wrong.

### 24.7 What M15 Actually Retired (settled at the milestone, 2026-08-21)

§24.4 above was written before the decommission and reads, in places, as
though every listed section survives *as implemented code*. M15 measured its
gate, passed it, and then had to decide that question concretely. This section
records the answers so a later reader does not have to re-derive them from a
deletion diff, and so §24.4's list is not mistaken for a promise the tree
keeps.

The rule applied was: **a mechanism survives if it still has a subject once no
code-symbol node or edge can exist.** Everything below follows from it.

1. **§9 (hybrid retrieval) — implementation retired, shape survives.** §24.4
   already said the *shape* is reused pointed at experience content, and that
   reuse is `packages/episodic`'s `queryByMeaning` (full-text + trigram +
   vector, fused by weighted RRF). What retired is `packages/retrieval`: its
   subject was nodes, and hybrid search over an empty table is not a
   degradation, it is nothing. The one part of it with a subject beyond the
   graph — the injected `EmbeddingProvider`, which §24.2.1's vector leg and
   `packages/capture` both need — moved into `packages/core`.

2. **§10-§11 (traversal, ranking) — retired.** M14's spike was the standing
   hypothesis that traversal moves up a level to memory-to-memory edges, and
   it returned NO-GO. With no code edges and no memory edges, `traverse` had
   nothing to walk. §10's batching guidance stays written down for whoever
   revisits M14's `reverts` / `shares_issue` relations with a better-designed
   measurement.

3. **§7 / §3.3 (promotion thresholds, confidence vs weight) — the decisions
   stand, the edge-level implementation retired.** `packages/semantic`
   computed a `SemanticStage` from an edge's provenance list and promoted the
   edge. Both of its inputs were edges. §24.2 decision 4 had already
   relocated §7/§13's *update path* to read-repair at the moment of use, which
   shipped in M13 as supersede chains — so what M15 removed is the older
   realization of an idea that already had a newer one, not the idea.
   `Provenance`, `ProvenanceSourceType` and §4's `EVIDENCE_HIERARCHY` are kept
   in `packages/core`: §4 is a vocabulary, it is cheap, and a memory is the
   obvious future carrier for it.

4. **§12 (lazy edge verification) — retired.** It answered "do this edge's
   structural endpoints still exist". Neither term survives. §24.2.3's
   git-driven memory staleness is the verification that remains, and it never
   needed the parser.

5. **§18 (GC) — stands, on one signal instead of three.** It used to
   hard-delete soft-deleted nodes past 90 days, hard-delete invalidated edges
   past 30, and mark a memory cold once every node it bound to had a durable
   edge. The first two collected rows that no longer exist. The third was
   *already* inert for every memory captured since M12 — its test asked
   whether each `relatedNodes` entry resolved to a node, and a text anchor
   never does — so removing it removed no live behaviour. What §18 has left is
   §24.5's: short-term memories no session has usefully accessed inside their
   idle window, reported and deliberately not acted on, because `cold` is a
   hard filter on every by-meaning leg and §24.5 forbids retrieval missing a
   correct memory outright.

6. **§17 (context construction) — one section instead of five.** Subsystems,
   relationships, invariants and source files were projections of the graph.
   Nothing replaced them: the agent reading the context already has the
   working tree, and `E2E_BENCHMARK_MULTI_REPO.md` is the measurement that
   re-describing the code to it loses to letting it grep. `Prior Experience`
   is the section grep cannot produce.

7. **§3.2 (node identity) — generator retired, recogniser kept.** `nodeId()`
   is gone. `isNodeId()` is not: rows written before M15 still carry 32-hex
   node ids in `related_nodes`, and `anchorsFromRelatedNodes` must keep
   telling them apart from paths — dropping the test would not delete old node
   ids, it would silently reclassify them as file paths that match nothing.

8. **§13's "disputed" state has no successor, and that is a real gap rather
   than a relocation.** §24.2 decision 4 relocated §13's *update* path to
   read-repair, and M13 shipped it — but a supersede resolves a conflict by
   *replacing*, which cannot express "two equally-trusted sources disagree and
   we do not know which is right". `EdgeStatus: "disputed"` and
   `resolveConfidence`'s same-tier disagreement detection went with the edges
   they described, and nothing on a memory represents that state today. It is
   named here rather than quietly dropped: if it comes back it belongs on the
   memory (two live chain heads that contradict each other), not on an edge,
   and it needs a measurement showing the state is reachable often enough to be
   worth representing.

9. **§22 (pipeline orchestration) — the composition stands, its interface does
   not.** §22 specified seven steps over `retrieveSeeds` → `traverse` →
   `getNodesByIds` → `queryByNode` → `buildContext`, with `graph` and
   `reasoner` as required injections and `seeds`/`traversal` on the result.
   Five of those seven no longer exist. `runPipeline` is now embed-once →
   by-meaning (§24.2.1) → read-time staleness (§24.2.3) → `buildContext` (§17),
   and takes neither a `GraphProvider` nor a `ReasoningProvider`. §22's
   *argument* is untouched and is why the package still exists: the stages must
   be composed in one place rather than reassembled by every caller, which is
   exactly what §22 observed was missing. Only the stage list changed. §22 now
   carries a pointer to this item so it is not read as current.

10. **§14 (event sourcing) — stands, with the retired half explicit.** The
   event vocabulary keeps naming `SymbolAdded` / `CodeChanged` /
   `SymbolRemoved` / `RelationAdded` / `RelationInvalidated` /
   `ExperiencePromoted`, because the log is append-only and every database
   that ever ran an extraction is full of them. The materializer skips them
   and *counts* the skips, so a rebuild reports that it dropped a projection
   rather than either failing or silently claiming a faithful replay.

**What is NOT retired, and was specifically checked:**
`experiences.related_nodes` and its GIN index. The column's name points at
node ids, which makes it look like a node-gating surface; since M11 it holds
text anchors, and `listExperiencesByAnchorPaths` matches on both it and
`anchors` precisely so that pre-M12 memories — which have anchors *only*
there — remain reachable by §24.2.3's staleness pass. Retiring it would have
been data loss wearing a cleanup's clothes.

---

## 25. Storage Backend: SQLite (extends §16 — direct human decision, 2026-08-21)

§16 commits to a single Postgres "until a measured bottleneck justifies
splitting out a dedicated engine." That escape hatch points *up* — toward
more specialized engines at greater scale. This section takes the exit §16
does not contemplate: at the scale this system actually operates, the single
Postgres **is** the bottleneck — not on latency, on adoption.

§16 is extended, not contradicted. Its deferral principle survives inverted:
re-adding a server backend is deferred, not rejected, and §25.7 names its
trigger.

### 25.1 The measurement

Measured 2026-08-21 against the live system, not estimated:

- **Corpus size: 34 memories.** `packages/capture/src/corpus.ts:77` admits a
  commit only when its meaningful body is ≥ 200 chars, so a mature repo lands
  in the hundreds-to-thousands, not millions.
- **Install cost: 621 MB** (`pgvector/pgvector:pg16`) for roughly 1 MB of
  text, behind a Docker daemon, a free port, two databases, two
  `CREATE EXTENSION`s, a `DATABASE_URL` and eight migrations.
- **pgvector's HNSW index buys nothing at this scale.** Brute-force cosine
  over 10,000 × 1536 Float32 vectors plus a top-10 sort is **19 ms** in plain
  JS — 300× the current corpus, no index, no extension.
- **The vector leg is the least load-bearing of the three.** Its only
  embedder is `createFakeEmbedder` (feature hashing, no measured retrieval
  quality), carrying RRF weight 0.5 (`DEFAULT_LEG_WEIGHTS`,
  `packages/episodic/src/byMeaning.ts`). `BENCHMARKS.md`: MRR 0.85
  lexical-only vs 0.90 with the stub. The single hardest Postgres dependency
  serves the weakest leg.

  > **This bullet was overtaken on 2026-09-03; the rest of §25.1 stands.**
  > The vector leg's embedder is no longer `createFakeEmbedder`:
  > `createLocalEmbedder` (`Xenova/all-MiniLM-L6-v2`, q8 ONNX, 384-dim,
  > `packages/core/src/embedding.ts`) runs locally, with a measured number
  > behind it in `BENCHMARKS.md`. The measurement above is left as written
  > because it is what §25's decision actually rested on in 2026-08-21, and
  > the decision is unaffected — a real embedder is a WASM/native dependency,
  > not a Postgres one, so the weakest-leg argument being overtaken does not
  > return pgvector to contention. The RRF weight is still 0.5.
- **Coupling is already narrow.** Exactly one file imports `pg`
  (`packages/graph-store/src/db.ts`). `capture`, `context`, `core`, `gc`,
  `pipeline`, `staleness` and `tiers` never name a client type.

### 25.2 The decision

**SQLite is the only backend.** Postgres is removed, not retained behind a
storage seam. A dual-backend seam would double 68 query sites and the
integration matrix permanently to serve a networked-team-memory deployment
that does not exist.

**Driver: `better-sqlite3`.** Chosen over Node's built-in `node:sqlite`,
which ships *without* FTS5 (verified on Node v22.14 / SQLite 3.47.2 — the
full-text leg is the strongest one at MRR 0.75, so losing FTS5 is not
acceptable). This is a new native dependency; CLAUDE.md's flag-and-wait rule
was honoured — it was flagged and explicitly approved, not quietly added.
Installed from a prebuilt binary in 7 s with no compiler, and SQLite 3.53.4
was verified to provide FTS5 + `bm25()`, `tokenize='trigram'`,
`json_each`/`json_extract`, 1536-dim Float32 blob round-trip, `foreign_keys`
enforcement and `WITH RECURSIVE`.

### 25.3 Retrieval legs

| Leg | Postgres today | SQLite |
| --- | --- | --- |
| text | `to_tsvector` / `ts_rank` / `@@` | FTS5 external-content table, ranked by `bm25()` |
| text (query) | `to_tsquery('english', 'a \| b')` | `MATCH 'a OR b'` — OR-across-documents semantics verified equivalent |
| trigram | `word_similarity` / `<%` + GUC threshold | FTS5 `tokenize='trigram'` substring match |
| vector | `vector(1536)`, `<=>`, HNSW | Float32 `BLOB`, cosine computed in JS. **No vector extension** — §25.1's 19 ms |

**`fuseLegs()` is unchanged.** Weighted RRF reads each leg's *rank order* and
never its score, so `bm25()`'s scale differing from `ts_rank`'s cannot move
the fused result while the orderings stay comparable. This is precisely what
makes the port measurable rather than a rewrite on faith: retrieval quality
must not move (§25.5).

### 25.4 Deleted rather than ported

- **Both `pg_advisory_lock` uses** — the migration lock
  (`packages/graph-store/src/migrate.ts`) and the supersede serialization
  lock plus its `FOR UPDATE` row lock
  (`packages/graph-store/src/experiences.ts`). SQLite has one global write
  lock, so what those locks simulate is the engine's default; WAL plus a
  busy timeout replaces them, and the documented supersede deadlock analysis
  becomes moot.
- **`set_config('pg_trgm.word_similarity_threshold', …)`** — a constant once
  the threshold is not a session GUC.
- **Both `CREATE EXTENSION`s**, CI's Postgres service container, and
  `scripts/setup-dev-db.sh`'s entire Docker-vs-apt detection.
- **`DATABASE_URL` as a hard requirement.** Integration tests currently
  self-skip without it; after the port there is nothing to skip on.

### 25.5 Rewritten, and how

Postgres-only constructs and their decided replacements:

| Construct | Sites | Replacement |
| --- | --- | --- |
| `unnest($1::text[], …)` | `experiences.ts`, `tiers.ts` | `json_each` over a JSON array parameter |
| `anchors @> ANY ($1::jsonb[])` | `experiences.ts` | `json_each` + `json_extract` |
| `count(*) FILTER (WHERE …)` | `tiers.ts` | `sum(CASE WHEN … THEN 1 ELSE 0 END)` |
| `IS NOT DISTINCT FROM` | `tiers.ts` | `IS` (SQLite's `IS` is null-safe) |
| `nextval('experience_settle_seq')` | `tiers.ts` | counter row bumped inside the same write transaction |
| `bigserial` | `events.id` | `INTEGER PRIMARY KEY AUTOINCREMENT` |
| `timestamptz` | throughout | **TEXT, ISO-8601 UTC** — not a Unix integer, so the database stays greppable and diffable, consistent with §24.2.2's reasoning for text anchors |
| plpgsql `DO $$ … EXCEPTION` | migration 0007 | plain DDL in the baseline |

Two further decisions, so a later cycle does not re-derive them:

1. **Migrations are rewritten as one SQLite baseline, not translated
   0001→0008.** Those eight files encode the history of a schema that still
   contained `nodes`/`edges` until 0008 dropped them; replaying that history
   on a new engine reproduces archaeology for no benefit. The runner keeps
   its applied-check contract.
2. **There is no data-migration path from an existing Postgres database.**
   Mined memories are reproducible — `sync` is idempotent and reads git in
   ~240 ms. Scout reports are the one class that is *not* reproducible from
   any external source, so the port ships a one-shot export/import for those
   specifically and nothing else.

### 25.6 Deferred: markdown as the source of truth

Named here so it is not re-derived from scratch; **not decided by this
section.** Memories would become `.md` files with YAML frontmatter —
git-versioned, greppable, reviewable in a PR — with SQLite demoted to a
derived, gitignored index rebuilt from those files (the same
source-of-truth-plus-projection shape `packages/graph-store/src/materializer.ts`
already implements for events).

It is deliberately a *second* milestone, because a port bug and a redesign
bug are indistinguishable in one step: §25.5's gate only means something
while behaviour is held constant.

Three known obstacles, all of which the split *resolves* rather than creates
— every one is an objection to storing operational state in knowledge files,
not to markdown:

- **Retrieval writes.** `packages/graph-store/src/tiers.ts` increments
  `access_count` and upserts `experience_accesses` on every `ask`, so a pure
  markdown corpus would rewrite frontmatter on every question asked.
- **`experience_accesses` is a join, not an attribute.** Its `(memory,
  session)` primary key is what makes §24.5's no-self-promotion rule
  structural rather than conventional.
- **Embeddings are 6144 bytes per memory**, which in frontmatter destroys the
  diffability that motivated markdown in the first place.

#### 25.6.1 Priced, then deferred (2026-08-27)

§25.6 above was written as "deferred, and here is the shape it would take". It is
now deferred *with a price attached*, by direct human decision at the point where
the port had landed and this milestone was next in line. The three obstacles
listed above were all solvable — the run that priced this designed the file
format, the write-ordering rule and the rebuild before stopping — and none of
them is why it stopped.

What stopped it is that the milestone has no failable number. §25.7 already
disclaims a latency claim and a quality claim; ROADMAP.md M18's gate is "MRR
unchanged". Set against that: on the corpus that actually exists, every memory is
a mined commit body, so the git-versioned/greppable/PR-reviewable properties
markdown buys are properties the host repository already has for that class —
`git log --grep` reaches the same text without a second copy of it. The class
where the argument does hold is the scout report, and §25.5 decision 2 already
gives that class a portable export for exactly the reason it holds (nothing can
regenerate one).

The cost, by contrast, is permanent and sits on the write path: four writers
would have to keep a file and a row in step, hand-edit semantics would have to be
decided (whether an edited observation invalidates the embedding and the
`verified_at` that was claimed about the old text — both yes, in the draft), and
the rebuild would need a prune guard plus a whole-corpus cycle check that the
per-link one in `supersedeExperience` cannot stand in for.

So the decision recorded here is: **SQLite stays the only store, and the
source-of-truth split waits for a corpus it would actually pay for.** Two
triggers, named the way §25.7 names its scale ceiling rather than left to taste —
a corpus dominated by memories that are *not* reproducible from the host
repository's own history (hand-authored knowledge, or scout reports outnumbering
mined commits), or a second consumer that must read the corpus without running
this CLI. Neither exists today.

Related, and the reason this was priced at all rather than built on schedule: the
2026-08-27 dogfood A/B in `BENCHMARKS.md` had just located the measurable loss in
retrieval *output* (`ask` printed only the first 14 lines of each memory, cutting
the deciding sentence out of 3 of 6 answers), not in storage shape.

### 25.7 What this section does not claim

- **No latency claim.** Postgres was never too slow. §25.1's figures show
  headroom, not a regression being fixed.
- **No retrieval-quality claim.** The gate is that quality does **not**
  change (§25.3).
- **The scale ceiling is real and accepted.** Brute-force vector search is
  O(n); somewhere around 10^5 memories the vector leg needs an index again.
  That trigger is named, not solved — and it, or a genuine multi-writer
  deployment, is what would reopen §16's server-backend question.
- **The stack is Postgres until the port actually lands.** CLAUDE.md's
  locked-stack rule and README's Quickstart are updated by the porting
  milestone, not by this section.

### 25.8 What the port measured (M17, added by the porting milestone)

§25.5 set the gate: retrieval quality must not change. It changed, upward, and
this section records what moved and why rather than re-baselining the number
(ROADMAP.md M17 is explicit that a moved number is to be reported, not
absorbed).

**Result.** by-meaning MRR **0.85 → 0.883** lexical-only, **0.90 → 0.933** with
the stub embedder, recall **0.90 → 1.00**, on the same corpus, questions and
scorer (`eval/why-spike`, 142 mined memories from `colinhacks/zod`). One
question improved from MISSING to rank 1 (`domain-lookahead`) and one regressed
from rank 1 to rank 3 (`base64-revert`).

**Where it came from — one leg of three.** Each leg was compared against
Postgres directly, not inferred from the fused number:

- **trigram: identical.** `word_similarity` is reimplemented exactly rather
  than replaced by §25.3's proposed `tokenize='trigram'` (see the deviation
  below). Over the full cross product of the gate corpus — 10 questions x 142
  memories, 1,420 pairs, pg values read out of Postgres — 1,386 agree exactly,
  34 differ by at most 0.0073, **no pair crosses the 0.35 threshold**, and the
  leg returns the same hits in the same order for all 10 questions.
- **vector: identical on 9 of 10 questions**, and the tenth differs only at rank
  20 of 20 — a tie at the `LIMIT` boundary, worth ~0.006 of an RRF score in a
  top-5 result.
- **full-text: genuinely different.** `ts_rank` and `bm25()` are different
  ranking functions over largely the same candidate set. `domain-lookahead`'s
  answering commit ranks **24th of 36** matching memories under `ts_rank` — i.e.
  outside the leg's `LIMIT 20` window, which is exactly the corpus-growth
  weakness `BENCHMARKS.md` already recorded for that question — and **1st**
  under `bm25()`.

**Reproducing 0.85 exactly was possible and was rejected.** It would have meant
reimplementing `ts_rank` plus Snowball English stemming plus Postgres's stopword
list in JS, and abandoning the FTS5 index §25.3 chose — rebuilding Postgres's
ranking function rather than porting to SQLite, to reproduce a *worse* number.
That is optimizing for the gate instead of for the product.

#### Deviations from §25.3, and why

1. **The trigram leg is not FTS5's `tokenize='trigram'`.** That is a substring
   matcher; the leg it replaces is a scorer with a threshold. The leg turned out
   to be load-bearing — measured on the Postgres baseline before any code moved,
   removing it drops MRR from 0.85 to **0.75**, and it decides the top-ranked hit
   on three of the ten questions — and it is narrow rather than broad: at the
   0.35 threshold it returns 0 to 3 hits out of 142 per question. Swapping a
   scorer for a substring matcher would have changed the fused ranking in a way
   the gate could not attribute. So `word_similarity` is reproduced in JS and
   pinned against 70 Postgres-produced fixture values.

2. **`experiences.anchors` and `related_nodes` have no index.** Postgres had GIN
   containment; SQLite has no equivalent for a JSON array, so
   `listExperiencesByAnchorPaths` scans. Accepted on §25.1's own reasoning — it
   runs once per sync/stale pass, not per retrieval — and the alternative (a
   normalized `experience_anchors` table) is a schema reshape, which the port is
   not allowed to do.

3. **`nextval()` becomes one `settle_seq` per settle *call*, not per row.** A
   settle call is per-session, so the granularity the watermark reads is
   preserved exactly; see `graph-store/src/tiers.ts`.

#### Cost, measured

- **Install: 621 MB → 0.** No image, no daemon, no port, no `DATABASE_URL`, no
  CI service container. The store is one file; `pnpm install && pnpm test` is
  the whole setup.
- **On disk:** 1.3 MB for 142 memories lexical-only, 2.1 MB with 1536-dim
  Float32 embeddings.
- **`sync` on this repository:** 181 ms for 35 explanatory commits.
- **Retrieval latency, 142-memory corpus:** full-text (FTS5) 2 ms, vector (JS
  cosine) 2 ms, trigram (JS scan) 107 ms, `queryByMeaning` end to end ~103 ms.

The trigram leg is the outlier and its cost is O(corpus), so §25.7's scale
ceiling now has a second occupant — and a nearer one, since the vector leg's
limit is around 10^5 memories while this becomes the dominant cost far earlier.
Getting there took three exact pruning bounds (3.9 s → 107 ms per question; the
reasoning and the two ways the bounds fail on their own are in
`trigram.ts`). The leg's own docstring names the change that would let it use an
index instead of a scan — isolating identifier terms rather than matching the
whole question — which was already a measured follow-up before the port.

#### What the independent review pass changed (and what it did not)

The review ran on the finished diff, cold, against the ten areas a port like
this can break silently. It found nothing in the `$n` translation, the row
decoding, the LATERAL rewrite, the `nextval` replacement, the timestamp
normalization, the FTS5 trigger sync (checked against VACUUM and
`integrity-check`) or the anchor lookup. It found eight real defects, and two of
them are decisions worth recording here rather than only in the commit:

1. **A harness must declare its database.** §25.1 counted "no environment
   variable needed to run" as the adoption win, and it is — for the product. For
   the eval harnesses it was a hazard the Postgres era had masked: `DATABASE_URL`
   being mandatory meant there was no default to fall into, and removing it
   pointed `eval/why-spike`'s capture (142 memories mined out of a *foreign*
   repository) and `eval/tier-promotion`'s report (which rewrites `tier`,
   `access_count`, `last_accessed` and `experience_accesses` as it replays
   synthetic traffic) at this repo's own dogfooded `.claude/memory.db`, which has
   no un-mine. So `useScratchDatabase` requires `MEMORY_DB` for harnesses only.
   The product keeps its zero-configuration default; the scripts that write a
   corpus they cannot retract do not get it.

2. **The transaction queue serializes transactions, not writes.** There is one
   connection, so an untransacted `getDb().query(...)` issued while a
   transaction is open lands *inside* that transaction and rolls back with it —
   where Postgres would have sent it out on another pooled connection and
   committed it independently. Nothing in this package writes that way (every
   multi-statement write either owns its transaction or takes a branded
   `TransactionClient`), so this is documented and pinned by a test rather than
   architected around. The related defect was real, though: `withTransaction`
   resolved `getDb()` when the *queue* reached it, so a transaction enqueued
   across a `closeDb()` silently reopened `defaultDatabasePath()`. It now
   captures the handle at call time and fails on a closed connection instead.

The other six were straightforward: the trigram leg's `minScore` floor could
prune the exact-threshold hit it was supposed to keep; the scout-report transfer
carried the memory but not its `superseded_by`/`verified_at`/`writer_session`
state, so a retracted report came back as a live chain head; `self-memory.mjs`
read commands crashed on an unmigrated file (`getDb()` creates it empty) instead
of reporting an empty memory; `stats`' `sum(CASE ...)` returned NULL where
`count(*) FILTER` returned 0; `cosineSimilarity` scored the shared prefix on a
dimension mismatch where pgvector raised; and the harnesses did not migrate the
file they opened, which is what the `BENCHMARKS.md` reproduce command does on a
clean machine.

**The gate was re-measured after the fixes, not assumed:** 0.883 lexical-only
and 0.933 with the stub embedder, recall 1.00 — identical to the numbers above.

---

## 26. Distilled Memories (extends §8, §24.2.1 — proposed via this experiment, 2026-08-28)

### 26.1 The problem this addresses

A mined memory is a raw git commit body, stored verbatim as
`experiences.observation` (`packages/capture/src/git.ts`). That is the right
*content* — `WHY_MEMORY_SPIKE.md` measured it cutting an agent from 7.7 turns to
1.4 — in the wrong *shape*. A commit body is written for a reviewer who already
has the diff open: it is long, it buries the decision in the middle, and it is
full of terms that match a question's words without answering the question.

The 2026-08-28 real-prompt replay (private `claude-notebook-benchmark`
repo, BENCHMARKS.md) priced that
shape. After the calibration pass cut the median injection from 8,970 to 3,922
characters, the memory arm still lost the blind pairwise judge 11/6/2 and cost
32% more than plain grep+git. Cutting the injected *size* moved cost by 1%,
which says the problem is not volume. The hypothesis §26 tests is that it is
shape: that a short summary written *for retrieval* both matches better and
reads better than the body it was written from.

### 26.2 The decision

`experiences` gains a `digest` column (migration `0003`). After capture, `sync`
sends each memory's `task`, `observation` and anchor paths to an LLM and stores
a ≤120-word, three-line `What:` / `Why:` / `Where:` summary. Retrieval then
searches `task || ' ' || coalesce(digest, observation)` on all three legs, and
`ask` renders the digest.

Four properties are load-bearing:

1. **`observation` is never modified.** §8's append-only rule is unchanged.
   `digest` is *derived*, in exactly the sense `embedding` is: reproducible from
   the memory, and `UPDATE experiences SET digest = NULL` returns the system to
   raw-body retrieval with nothing else to undo. The digest is a lossy view; the
   commit body remains the record, one `show <id>` away.
2. **`coalesce`, not a switch.** A half-distilled corpus is a valid corpus —
   distilled rows are searched by digest, undistilled ones by body, in the same
   query. That is what makes the pass resumable and what makes a missing `claude`
   binary a degradation rather than a failure.
3. **One derived column invalidates the other.** `setExperienceDigest` writes the
   digest and nulls the embedding in one statement, so the existing
   `listExperienceIdsMissingEmbedding` backfill re-embeds from the digest on the
   same `sync`. Nothing new was built for that; the invariant is expressed where
   it cannot be forgotten rather than as a rule a caller must follow.
4. **The runner is injected.** `distillExperiences({ runner })` takes
   `(prompt) => Promise<string>`; `createClaudeCliRunner` is the shipped default.
   The pass is therefore testable without an LLM, and a caller who wants a
   different model or a local one does not need a code change here.

### 26.3 What is NOT decided here

This does not reintroduce a per-language dependency (§24.2 point 7): the prompt
carries text and paths, and `--allowedTools ""` keeps the runner from reading
the repository at all. It does not change `fuseLegs`, the tier boost, or the
§7 promotion thresholds. It does not make the digest authoritative — every
consumer that needs the real text reads `observation`, and `show` prints both
precisely so a reader can see what the summary dropped.

### 26.4 Cost, stated plainly

Distillation is the first thing in this system that costs money per memory.
One Haiku call per memory, once for that memory's life, bounded per `sync` by
`limit` (200 by default). On the 215-memory replay corpus that is a one-time
spend measured in single-digit dollars; a 5,000-commit repository would be a
different conversation, which is why §26.6 leaves the pass **off unless
`CLAUDE_NOTEBOOK_DISTILL=1` is set** — a system that spends money per memory
must be asked to, not asked to stop. A skipped memory (empty or
oversized runner output, a timeout, a refusal) keeps a NULL digest and is
retried by the next `sync`, which is the right failure mode for a transient
error and costs one retry rather than a re-run of the corpus.

### 26.5 The acceptance question

This section is an experiment with a stated null hypothesis, and §26 records
the verdict either way. Distillation pays only if the real-prompt replay —
the same 19 prompts, the same clone, the same blind pairwise judge — moves
against the calibrated-but-undistilled arm. It does not pay if the judge tally
and the cost delta are flat, and a flat result is a reason to null the column,
not a reason to look for a better prompt. See BENCHMARKS.md's 2026-08-28
distillation row for what actually happened.

### 26.6 The verdict (2026-08-28)

**It did not clear the bar, and the column is retained un-defaulted rather than
declared a win.** Measured on the same 19 prompts and the same clone:

- Median injected context per fired prompt 3,922 → **3,167** chars (−19%).
- Median turns over the 12 fired prompts 6.5 → **4.5** (baseline grep+git: 6.5).
- Median cost over those prompts $0.256 → **$0.244**, still **+43%** over the
  $0.171 baseline. Median wall 24.5 s → **33.7 s**, i.e. worse.
- Answers citing an injected memory **4/19 → 2/19**. The digest is read less
  often than the body it replaced, which is the opposite of §26.1's hypothesis.
- One-time spend **~$8.4** for 215 memories, and a new per-memory dependency on
  an LLM at capture time.

The blind judge moved 11/6/2 to 4/14/1, and that number is **not** evidence.
The methodological point is worth more than the experiment: on the 7 prompts
where the hook did not fire, the two arms are configuration-identical, and the
judge still picked the memory file 6 times, tied once, and the baseline zero.
The calibrated run's identical control had been a balanced 3/3/2. So the noise
floor itself moved between the two runs — the baseline `*-off.json` files are
hours older than the distilled ones — and the 8/4 split on the 12 fired prompts
sits inside that drift. **A reused baseline arm is only valid while its own
null control stays balanced; this one did not, and the pairwise result is
therefore uninterpretable rather than favourable.** Any future re-run of
the replay must regenerate both arms together, or check this control
before quoting a judge tally.

What is kept and why: the column, the migration and the `coalesce` fallback
stay, because they cost nothing when no digest exists and because the −19%
injection and the 6.5 → 4.5 turn movement are real, reproducible, and worth
re-testing on a corpus of long commit bodies. This one is not that corpus —
its mean body is **937 characters** against a mean digest of **715**, so there
was only ~24% of shape to win, and two digests came out *longer* than the body
they summarise. §26.5's own rule says a flat result is a reason to null the
column; M19 stays unchecked.

**The default was then decided by a human (2026-08-29): distillation is OFF
unless `CLAUDE_NOTEBOOK_DISTILL=1` is set.** A measured-negative feature does
not get to spend a user's money by having to be switched off. What turning it
on is for is worth stating so a later cycle does not re-derive it: a corpus
whose commit bodies are long enough that a 120-word digest is a real reduction.
This one, at a 937-character mean body, was not.
