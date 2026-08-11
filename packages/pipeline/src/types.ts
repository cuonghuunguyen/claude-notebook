import type { AgentContext, BuildContextOptions } from "@cognitive-memory/context";
import type { EmbeddingProvider, RetrieveOptions, SeedNode } from "@cognitive-memory/retrieval";
import type { GraphProvider, ReasoningProvider, TraversalResult, TraverseOptions } from "@cognitive-memory/traversal";

/** spec.md §22: composes retrieval (§9) / traversal (§10) / context (§17) into one entry point. */
export interface PipelineOptions {
  repoId?: string;
  /**
   * Shared with both retrieval's vector leg and traversal's ranking term —
   * computed at most once per `runPipeline` call (spec.md §22 step 1), never
   * independently by each stage, so the two stages can't disagree about
   * what "semantically relevant to this task" means for the same call.
   */
  embedder?: EmbeddingProvider;
  graph: GraphProvider;
  reasoner: ReasoningProvider;
  retrieveOptions?: Omit<RetrieveOptions, "embedder" | "repoId">;
  traverseOptions?: Omit<TraverseOptions, "graph" | "reasoner" | "taskEmbedding">;
  contextOptions?: BuildContextOptions;
  /**
   * Flat cap on hydrated experiences across the whole subgraph, independent
   * of node count — keeps this bounded the same way §17's own DEFAULT_MAX_*
   * caps bound `buildContext`'s output. Default 20.
   */
  maxExperiences?: number;
}

export interface PipelineResult {
  context: AgentContext;
  /** Surfaced for callers/eval harnesses that need to see *why* — spec.md §9. */
  seeds: SeedNode[];
  /** Surfaced for callers/eval harnesses that need to see *why* — spec.md §10. */
  traversal: TraversalResult;
}
