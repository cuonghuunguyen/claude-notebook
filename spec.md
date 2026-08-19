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

## 22. Pipeline Orchestration (extends §1, §9, §10, §17 — proposed via `/propose-milestone`)

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
