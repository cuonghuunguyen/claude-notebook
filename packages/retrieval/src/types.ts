/**
 * Injected embedding interface (spec.md §9 "packages/retrieval must not
 * hard-depend on a specific embedding API"). Tests use the deterministic
 * fake in fakeEmbedder.ts; a real provider is wired in at the application
 * layer.
 */
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

export type SeedReason =
  | "lexical_match"
  | "semantic_match"
  | "hybrid_match"
  | "structural_neighbor"
  | "semantic_neighbor";

/** spec.md §9 seed-node shape: `{ nodeId, score, reason }`, not a text chunk. */
export interface SeedNode {
  nodeId: string;
  score: number;
  reason: SeedReason;
}

export interface RetrieveOptions {
  /**
   * Scope both search legs to one repo (graph-store's repo_id column) —
   * a retrieval session operates against a single repo's graph. Omit only
   * when the store is known to hold exactly one repo's nodes.
   */
  repoId?: string;
  /** Embedding provider for the vector leg. Omit to run lexical-only. */
  embedder?: EmbeddingProvider;
  /** How many top hits from the merged lexical+vector rank feed seed expansion. Default 3 (spec.md §9). */
  expansionSeedCount?: number;
  /** Cap on lexical/vector hits fetched per leg before merge. Default 10. */
  legLimit?: number;
  /** Cap on neighbor edges pulled per expanded node. Default 10. */
  neighborLimit?: number;
  /** Trigram similarity floor for the lexical leg. Default 0.1. */
  lexicalThreshold?: number;
}
