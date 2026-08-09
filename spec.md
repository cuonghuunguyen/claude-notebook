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
