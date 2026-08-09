// Mirrors spec.md §3-§8. Keep this file and spec.md in sync — this package
// is the contract every other package in the workspace imports against.

export type NodeType =
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

export type NodeStatus = "active" | "stale" | "deleted";

export type StructuralRelationType =
  | "contains"
  | "imports"
  | "exports"
  | "calls"
  | "references"
  | "extends"
  | "implements"
  | "uses"
  | "tested_by";

export type SemanticRelationType =
  | "depends_on"
  | "owns"
  | "constrained_by"
  | "violates"
  | "caused_by"
  | "prevents"
  | "requires"
  | "must_follow"
  | "alternative_to"
  | "related_to";

export type ExperienceRelationType =
  | "observed_in"
  | "fixed_by"
  | "learned_from"
  | "relevant_to";

export type RelationType =
  | StructuralRelationType
  | SemanticRelationType
  | ExperienceRelationType;

export type EdgeStatus = "active" | "stale" | "invalid" | "disputed";

export type ProvenanceSourceType =
  | "source_code"
  | "test"
  | "documentation"
  | "git_commit"
  | "pull_request"
  | "agent_experience"
  | "llm_inference";

/** Evidence hierarchy, highest trust first — spec.md §4. Lower index wins. */
export const EVIDENCE_HIERARCHY: readonly ProvenanceSourceType[] = [
  "source_code", // compiler/AST/LSP-derived facts are also tagged source_code with confidence 1.0
  "test",
  "documentation",
  "git_commit",
  "llm_inference",
] as const;

export interface Provenance {
  sourceType: ProvenanceSourceType;
  sourceId: string;
  evidence?: string;
  confidence: number;
  observedAt: string;
}

export interface NodeMetadata {
  keywords?: string[];
  embedding?: number[];
  language?: string;
  package?: string;
  module?: string;
}

export interface Node {
  /** hash(repoId, stableSymbolPath) — see spec.md §3.2. Stable across renames. */
  id: string;
  type: NodeType;

  name?: string;
  path?: string;

  summary?: string;

  metadata: NodeMetadata;

  provenance: Provenance[];

  createdAt: string;
  updatedAt: string;

  status: NodeStatus;
}

export interface Edge {
  id: string;

  from: string;
  to: string;

  relation: RelationType;

  /** 0–1: how likely this fact is true. See spec.md §3.3. */
  confidence: number;
  /** 0–1: how much this edge matters for ranking/traversal. See spec.md §3.3. */
  weight: number;

  provenance: Provenance[];

  status: EdgeStatus;

  createdAt: string;
  updatedAt: string;

  lastVerifiedAt?: string;
}

export type SemanticStage =
  | "observation"
  | "hypothesis"
  | "candidate"
  | "durable";

export interface Experience {
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

export interface TraversalBudget {
  maxDepth: number;
  maxNodes: number;
  maxEdges: number;
  maxReasoningSteps: number;
  maxTokens: number;
}

/** spec.md §10.1 default budget. */
export const DEFAULT_TRAVERSAL_BUDGET: TraversalBudget = {
  maxDepth: 3,
  maxNodes: 50,
  maxEdges: 100,
  maxReasoningSteps: 5,
  maxTokens: 8000,
};
