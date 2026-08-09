import type { Edge, Node, NodeType, RelationType } from "@cognitive-memory/core";

/**
 * spec.md §11 edge ranking, per-relation `relation_importance` term. Values
 * are a deliberate ordering, not a spec-given table (§11 lists the formula's
 * terms but not relation-specific weights): invariant/violation-adjacent
 * relations outrank plain structural navigation, matching §3.3's own example
 * ("a `must_follow` invariant outweighs a `references`").
 */
const RELATION_IMPORTANCE: Partial<Record<RelationType, number>> = {
  must_follow: 0.9,
  violates: 0.85,
  constrained_by: 0.8,
  caused_by: 0.75,
  depends_on: 0.7,
  requires: 0.7,
  prevents: 0.7,
  extends: 0.6,
  implements: 0.6,
  contains: 0.6,
  calls: 0.6,
  fixed_by: 0.6,
  learned_from: 0.6,
  uses: 0.5,
  tested_by: 0.5,
  observed_in: 0.5,
  relevant_to: 0.5,
  references: 0.4,
  alternative_to: 0.4,
  imports: 0.3,
  exports: 0.3,
  related_to: 0.3,
};
const DEFAULT_RELATION_IMPORTANCE = 0.4;

/**
 * spec.md §11 `node_importance` term, by neighbor node type. Same caveat as
 * above: §11 names the term, not the table. Subsystem/invariant/decision
 * nodes rank highest since they carry cross-cutting knowledge a single
 * function/variable node doesn't.
 */
const NODE_TYPE_IMPORTANCE: Partial<Record<NodeType, number>> = {
  subsystem: 0.9,
  invariant: 0.85,
  decision: 0.8,
  interface: 0.7,
  concept: 0.65,
  class: 0.65,
  bug: 0.6,
  module: 0.6,
  experience: 0.55,
  function: 0.5,
  method: 0.5,
  file: 0.45,
  type: 0.45,
  test: 0.4,
  directory: 0.3,
  repository: 0.3,
  variable: 0.3,
};
const DEFAULT_NODE_IMPORTANCE = 0.4;

/** Freshness half-life for §11's `freshness` term — an edge untouched for 30 days has decayed to roughly half its just-verified score. */
const FRESHNESS_HALF_LIFE_DAYS = 30;
/** Per-depth-level penalty for §11's `traversal_cost` term — deeper hops cost more, matching "marginal relevance becomes too low" as a legitimate stop condition (spec.md §10.1). */
const TRAVERSAL_COST_PER_DEPTH = 0.15;

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
  );
}

/**
 * spec.md §11's `task_relevance` term: lexical (token-overlap) similarity
 * between the task description and the candidate node's name/summary/
 * keywords. Deterministic and dependency-free, unlike `semantic_relevance`
 * below which needs an embedding — kept as a distinct term rather than
 * folded into it so traversal still has *a* task-relevance signal when no
 * embedder is wired in (see `taskEmbedding` on `TraverseOptions`).
 */
function taskRelevance(task: string, node: Node): number {
  const taskTokens = tokenize(task);
  if (taskTokens.size === 0) return 0;
  const nodeText = [node.name, node.summary, ...(node.metadata.keywords ?? [])]
    .filter(Boolean)
    .join(" ");
  const nodeTokens = tokenize(nodeText);
  if (nodeTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of taskTokens) if (nodeTokens.has(token)) overlap += 1;
  return overlap / taskTokens.size;
}

function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function freshness(updatedAt: string): number {
  const ageDays = (Date.now() - new Date(updatedAt).getTime()) / 86_400_000;
  return Math.exp(-Math.max(ageDays, 0) / FRESHNESS_HALF_LIFE_DAYS);
}

export interface ScoreInput {
  edge: Edge;
  neighborNode: Node;
  task: string;
  /** 1-based depth level of this candidate's frontier. */
  depth: number;
  /** Precomputed task embedding, if an embedder is wired in (see `TraverseOptions.taskEmbedding`). */
  taskEmbedding?: number[];
}

/**
 * spec.md §11: `score = semantic_relevance + relation_importance +
 * node_importance + confidence * weight + task_relevance + freshness -
 * traversal_cost`.
 *
 * `confidence * weight` is a product per §3.3, not two additive terms — a
 * high-importance-but-low-confidence edge and a high-confidence-but-low-
 * importance edge must not score identically, which plain addition would
 * allow.
 */
export function scoreCandidate(input: ScoreInput): number {
  const semanticRelevance =
    input.taskEmbedding && input.neighborNode.metadata.embedding
      ? cosineSimilarity(input.taskEmbedding, input.neighborNode.metadata.embedding)
      : 0;
  const relationImportance = RELATION_IMPORTANCE[input.edge.relation] ?? DEFAULT_RELATION_IMPORTANCE;
  const nodeImportance = NODE_TYPE_IMPORTANCE[input.neighborNode.type] ?? DEFAULT_NODE_IMPORTANCE;
  const confidenceWeight = input.edge.confidence * input.edge.weight;
  const relevanceToTask = taskRelevance(input.task, input.neighborNode);
  const freshnessScore = freshness(input.edge.updatedAt);
  const traversalCost = TRAVERSAL_COST_PER_DEPTH * input.depth;

  return (
    semanticRelevance +
    relationImportance +
    nodeImportance +
    confidenceWeight +
    relevanceToTask +
    freshnessScore -
    traversalCost
  );
}
