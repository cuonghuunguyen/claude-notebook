import type { Anchor } from "./anchors.js";

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

/** Runtime enumeration of StructuralRelationType — spec.md §9 seed expansion filters edges by this set. */
export const STRUCTURAL_RELATIONS: readonly StructuralRelationType[] = [
  "contains",
  "imports",
  "exports",
  "calls",
  "references",
  "extends",
  "implements",
  "uses",
  "tested_by",
] as const;

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

/** Runtime enumeration of SemanticRelationType — spec.md §9 seed expansion filters edges by this set. */
export const SEMANTIC_RELATIONS: readonly SemanticRelationType[] = [
  "depends_on",
  "owns",
  "constrained_by",
  "violates",
  "caused_by",
  "prevents",
  "requires",
  "must_follow",
  "alternative_to",
  "related_to",
] as const;

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

/**
 * Evidence hierarchy, highest trust first — spec.md §4. Lower index wins.
 * spec.md names 6 tiers (compiler/AST/LSP > tests > source code inference >
 * documentation > git history > agent inference); `ProvenanceSourceType` has
 * 7 values, so `pull_request` and `agent_experience` need a placement spec.md
 * doesn't give directly:
 * - `pull_request` sits just above `git_commit` — a reviewed diff carries
 *   more corroborating context than a bare commit message, but it's still
 *   git-history-adjacent, not code/test-derived.
 * - `agent_experience` sits above `llm_inference` — an experience reflects
 *   an agent actually acting and observing a real result, which is more
 *   grounded than pure LLM speculation, but still task-context-bound and
 *   thus less reliable than any code/history-derived evidence.
 */
export const EVIDENCE_HIERARCHY: readonly ProvenanceSourceType[] = [
  "source_code", // compiler/AST/LSP-derived facts are also tagged source_code with confidence 1.0
  "test",
  "documentation",
  "pull_request",
  "git_commit",
  "agent_experience",
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

  /**
   * Text anchors this memory binds to (spec.md §24.2.2 / ROADMAP.md M12):
   * `{ path, symbol? }`, never line numbers, never node ids.
   *
   * Alongside `relatedNodes` rather than replacing it, per ROADMAP M12 — the
   * structural graph is alive until M15 and still writes node ids there. New
   * knowledge binds here (spec.md §24.4); a pre-M12 memory's paths are read
   * out of `relatedNodes` by `anchorsFromRelatedNodes`.
   *
   * Optional so every existing `Experience` literal in the workspace stays
   * valid; storage normalizes a missing value to `[]`.
   */
  anchors?: Anchor[];

  /**
   * Set when a commit has touched one of `anchors`' paths since this memory
   * was recorded (spec.md §24.2.3). Persisted by the sync-time pass, and also
   * computed at read time from a single git lookup.
   *
   * A suspect memory is still returned, always — §24.2.3 is explicit that it
   * is flagged, never silently dropped, because the why-spike measured missing
   * context as a real cost too.
   */
  suspect?: boolean;

  /** Which change made it suspect, e.g. `modified src/parse.ts in a1b2c3d4`. */
  suspectReason?: string;

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

/**
 * spec.md §24.5 memory tiers. Ordered short → mid → long; a memory is born
 * short-term at capture and climbs only on *confirmed* cross-session use.
 *
 * Lives in core rather than in `packages/tiers` because it is part of the
 * stored shape of a memory (graph-store persists it, episodic ranks by it),
 * and core is the one package all three can depend on. The transition *rules*
 * are `packages/tiers`' business; only the vocabulary is here.
 */
export type MemoryTier = "short" | "mid" | "long";

/** Tiers in promotion order — index arithmetic for promote/demote. */
export const MEMORY_TIERS: readonly MemoryTier[] = ["short", "mid", "long"];

/**
 * How one (memory, session) access was settled once the session's task
 * outcome was known — spec.md §24.5's answer to "access is not correctness".
 *
 * `provisional` is the state every access lands in at retrieval time; it
 * never counts toward promotion, so an abandoned session promotes nothing.
 */
export type AccessOutcome =
  | "provisional"
  | "confirmed"
  | "rejected"
  | "unused"
  | "self";
