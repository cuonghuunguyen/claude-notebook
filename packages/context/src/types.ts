import type { Edge, Experience, Node, RelationType } from "@cognitive-memory/core";

/**
 * The output of retrieval+traversal (M2/M5): a set of hydrated nodes and the
 * edges traversal decided to EXPAND, plus whatever prior experiences the
 * caller already looked up for those nodes (via `hydrateExperiences` below,
 * or any other source). Building this is the caller's job — `buildContext`
 * itself does no I/O, per spec.md §17's "no new LLM call required" and
 * ROADMAP's "plain templating over the subgraph."
 */
export interface Subgraph {
  nodes: Node[];
  edges: Edge[];
  experiences?: Experience[];
}

export interface SubsystemSummary {
  nodeId: string;
  name: string;
  summary?: string;
}

export interface RelationshipSummary {
  edgeId: string;
  relation: RelationType;
  from: { id: string; name: string };
  to: { id: string; name: string };
  confidence: number;
  weight: number;
}

export interface InvariantSummary {
  nodeId: string;
  name: string;
  summary?: string;
}

export interface ExperienceSummary {
  experienceId: string;
  task: string;
  lessons: string[];
  result?: string;
  /**
   * `POSSIBLY_STALE_FLAG` when a commit has touched this memory's anchored
   * paths since it was recorded (spec.md §24.2.3), otherwise absent.
   *
   * The memory is still here — that is the point. §24.2.3 flags, never drops,
   * because `WHY_MEMORY_SPIKE.md` measured missing context as its own cost.
   * The agent reads the warning and decides whether to verify.
   */
  staleness?: string;
  /** Which change raised the flag, e.g. `modified src/parse.ts in a1b2c3d4`. */
  stalenessReason?: string;
}

export interface SourceFileSummary {
  nodeId: string;
  path: string;
  summary?: string;
}

/** spec.md §17's five-part compact projection, as a structured object — `render.ts` turns this into the text an agent actually reads. */
export interface AgentContext {
  task: string;
  subsystems: SubsystemSummary[];
  relationships: RelationshipSummary[];
  invariants: InvariantSummary[];
  experiences: ExperienceSummary[];
  sourceFiles: SourceFileSummary[];
}

export interface BuildContextOptions {
  /** Caps applied per section so the projection stays compact even if the caller hands in a larger-than-expected subgraph. */
  maxRelationships?: number;
  maxInvariants?: number;
  maxSubsystems?: number;
  maxExperiences?: number;
  maxSourceFiles?: number;
}
