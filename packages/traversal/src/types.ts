import type { Edge, Node, RelationType, TraversalBudget } from "@cognitive-memory/core";
import type { FrontierEdge } from "@cognitive-memory/graph-store";

export type { FrontierEdge };

/**
 * The graph access traversal needs, injected rather than imported directly
 * (same pattern as retrieval's `EmbeddingProvider`, spec.md ROADMAP M2) —
 * this keeps the budget/ranking/reasoning-loop logic in `traverse.ts` unit-
 * testable against an in-memory fixture, with the real Postgres-backed
 * implementation (`createPostgresGraphProvider`, frontier.ts) exercised
 * separately by the integration suite.
 */
export interface GraphProvider {
  /**
   * One frontier's worth of active edges touching `nodeIds` (spec.md §10,
   * §16: one batched query per depth level, not one per neighbor).
   * `excludeNeighborIds` is the full visited set so far — already-visited
   * nodes are never re-offered as "new" candidates.
   */
  getFrontier(nodeIds: string[], excludeNeighborIds: string[]): Promise<FrontierEdge[]>;
  /** Batch node hydration for a frontier's neighbor ids, one round trip. */
  getNodes(ids: string[]): Promise<Node[]>;
}

export type CandidateAction = "expand" | "skip";

/** One frontier candidate as presented to the reasoning call — post-ranking, post-cap (spec.md §10's "curated shortlist"). */
export interface FrontierCandidate {
  edgeId: string;
  relation: RelationType;
  neighborNodeId: string;
  /** spec.md §11 score, already computed — the reasoner sees the ranking, it doesn't recompute it. */
  score: number;
}

export interface ReasoningContext {
  task: string;
  /** 1-based depth level this frontier belongs to. */
  depth: number;
  visitedNodeIds: string[];
  /** Ranked, capped shortlist for this depth level — one reasoning call handles the whole batch (spec.md §10). */
  candidates: FrontierCandidate[];
  budget: TraversalBudget;
}

export interface ReasoningDecision {
  edgeId: string;
  action: CandidateAction;
}

export interface ReasoningResult {
  /** One decision per candidate passed in `ReasoningContext.candidates`. */
  decisions: ReasoningDecision[];
  /** spec.md §10: STOP — "required information is sufficient" or "marginal relevance too low", as judged by the reasoner itself. Budget-exhaustion STOPs are enforced by the traversal loop, not this flag. */
  stop: boolean;
}

/**
 * The reasoning call, injected like `GraphProvider` above — spec.md ROADMAP
 * M5: "testable with a scripted fake decision-maker, not a live LLM, in unit
 * tests." Exactly one `decide()` call per depth level, never per edge.
 */
export interface ReasoningProvider {
  decide(context: ReasoningContext): Promise<ReasoningResult>;
}

export type TraversalStopReason =
  /** A frontier fetch at some depth returned no candidate edges at all. */
  | "no_frontier"
  /** The top-ranked candidate's §11 score fell below the relevance floor — not worth a reasoning call. */
  | "low_relevance"
  /** The reasoner's `decide()` set `stop: true`. */
  | "reasoner_stop"
  /** The reasoner expanded nothing this level, so there is no next frontier to continue from. */
  | "no_expansion"
  /** `TraversalBudget` (spec.md §10.1) exhausted: maxDepth/maxNodes/maxEdges/maxReasoningSteps. */
  | "budget_exhausted";

export interface TraverseOptions {
  graph: GraphProvider;
  reasoner: ReasoningProvider;
  /** Overrides merged onto `DEFAULT_TRAVERSAL_BUDGET` (spec.md §10.1). */
  budget?: Partial<TraversalBudget>;
  /** Cap on ranked candidates handed to one reasoning call. Default 15 (spec.md §10's example). */
  frontierCap?: number;
  /** §11 score floor below which traversal stops without spending a reasoning call. Default 0. */
  minRelevanceScore?: number;
  /** Optional task embedding for §11's semantic_relevance term — omitted, that term contributes 0 (lexical task_relevance still applies). */
  taskEmbedding?: number[];
}

export interface TraversalResult {
  /** Seed node ids plus every node reached via an EXPAND decision. */
  nodeIds: string[];
  /** Every edge an EXPAND decision was made on. */
  edges: Edge[];
  depthReached: number;
  reasoningStepsUsed: number;
  stopReason: TraversalStopReason;
}
