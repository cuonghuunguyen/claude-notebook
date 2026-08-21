import type { Anchor } from "./anchors.js";

// Mirrors spec.md §4, §8 and §24. Keep this file and spec.md in sync — this
// package is the contract every other package in the workspace imports
// against.
//
// M15 removed the §3.1/§3.2 code-graph vocabulary that used to live here
// (`Node`, `Edge`, `RelationType`, `TraversalBudget`, `nodeId()`) along with
// the structural graph itself: nothing produced a code-symbol node any more,
// so nothing could consume one. What remains is the vocabulary of a memory
// (`Experience`, §8), the evidence it can rest on (`Provenance`, §4), and the
// tier it lives in (§24.5).

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

export interface Experience {
  id: string;

  task: string;

  observation: string;
  hypothesis?: string;
  action?: string;
  result?: string;
  lessons?: string[];

  /**
   * Legacy/mirrored anchor list — the paths in `anchors`, formatted as text.
   *
   * Named for what it held before §24.2.2: a list of structural node ids.
   * Those cannot be produced any more (M15), but existing rows still carry
   * them, which is why `anchorsFromRelatedNodes` still filters them out.
   * `anchors` is the typed home for new knowledge; this stays because it is
   * persisted history and because renderers read it.
   */
  relatedNodes: string[];

  /**
   * Text anchors this memory binds to (spec.md §24.2.2 / ROADMAP.md M12):
   * `{ path, symbol? }`, never line numbers, never node ids.
   *
   * Since M15 this is the ONLY place new knowledge binds; the structural
   * graph that used to write node ids into `relatedNodes` is gone. A pre-M12
   * memory's paths are still read out of `relatedNodes` by
   * `anchorsFromRelatedNodes`, which drops the node ids a legacy row may
   * carry (spec.md §24.4).
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

  /**
   * Set when read-repair recorded a corrected memory in this one's place
   * (spec.md §24.2 decision 4 / §24.6, ROADMAP.md M13): the id of the memory
   * that replaced it.
   *
   * A memory carrying this is out of default retrieval — the chain's head (the
   * memory with no successor) is the current answer. It is still reachable
   * explicitly, which is the whole reason the old text is kept rather than
   * rewritten: "what did we believe before, and what changed our mind" is a
   * question the corrected memory alone cannot answer.
   */
  supersededBy?: string;

  /** When the supersede link was made — not when either memory was written. */
  supersededAt?: string;

  /**
   * When read-repair last checked this memory against the code and found it
   * still accurate (§24.6).
   *
   * This is the memory's staleness reference instant, not merely an audit
   * field: §24.2.3's test is "is the newest commit touching my anchors newer
   * than me?", and after a verification the honest answer uses the verification
   * instant rather than the write instant. `stalenessAsOf` is the one place
   * that choice is made.
   */
  verifiedAt?: string;

  confidence: number;
  timestamp: string;
}

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
