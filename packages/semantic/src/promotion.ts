import type { EdgeStatus, Provenance, SemanticStage } from "@cognitive-memory/core";
import { resolveConfidence } from "./confidence.js";

/** spec.md §7's "candidate knowledge" cap — unlocked only once "durable" criteria are met. */
const CANDIDATE_CONFIDENCE_CAP = 0.75;
/** spec.md §7's literal "hypothesis" entry condition: confidence < 0.5. Below this, a fact stays a hypothesis even with ≥2-sourceType corroboration. */
const CANDIDATE_MIN_CONFIDENCE = 0.5;

export interface PromotionInput {
  /** All provenance recorded so far for one (from, to, relation) triple. */
  provenance: readonly Provenance[];
  /** Has this candidate survived an explicit verification pass (spec.md §8-style re-check)? Durable path 1. */
  verified?: boolean;
  /** How many separate agent tasks have referenced this fact without contradiction? Durable path 2 (spec.md §7: "≥2 separate agent tasks without contradiction"). */
  taskReferenceCount?: number;
}

export interface PromotionResult {
  stage: SemanticStage;
  confidence: number;
  /** "stale"/"invalid" aren't semantic's concern (spec.md §12/§14, M7) — promotion only ever produces active or disputed. */
  status: Extract<EdgeStatus, "active" | "disputed">;
}

/**
 * spec.md §7's promotion table, implemented as a priority ladder (each row
 * is evaluated only if the previous one's condition doesn't already apply):
 *
 *   1 provenance record                            -> observation
 *   confidence < 0.5, OR <2 distinct sourceTypes    -> hypothesis (spec.md's
 *                                                       literal entry
 *                                                       condition for this
 *                                                       row is confidence
 *                                                       alone; corroboration
 *                                                       is required in
 *                                                       ADDITION, per the
 *                                                       next row's "≥2
 *                                                       distinct sourceType
 *                                                       values" gate — a
 *                                                       fact can't become a
 *                                                       candidate on
 *                                                       confidence alone
 *                                                       without diversity,
 *                                                       or on diversity
 *                                                       alone without
 *                                                       confidence)
 *   confidence >= 0.5, >=2 distinct sourceTypes,      -> candidate,
 *   not yet durable                                      confidence capped
 *                                                         at 0.75
 *   confidence >= 0.5, >=2 distinct sourceTypes,      -> durable, confidence
 *   verified or referenced by >=2 tasks                  unlocked above 0.75
 *
 * Both gates are enforced explicitly (rather than treating one as a side
 * effect of the other) because they're independently reachable: 2 identical-
 * sourceType observations at confidence 0.95 have confidence well above 0.5
 * but no corroborating diversity: hypothesis. 2 distinct-sourceType
 * observations at confidence 0.1 each have diversity but confidence well
 * below 0.5: also hypothesis, not candidate — a low-confidence fact
 * shouldn't reach "candidate knowledge" just because two unconfident sources
 * happened to agree.
 */
export function computePromotion(input: PromotionInput): PromotionResult {
  const { provenance } = input;
  const { confidence: rawConfidence, disputed } = resolveConfidence(provenance);
  const status: PromotionResult["status"] = disputed ? "disputed" : "active";

  if (provenance.length <= 1) {
    return { stage: "observation", confidence: rawConfidence, status };
  }

  const distinctSourceTypes = new Set(provenance.map((p) => p.sourceType)).size;
  const corroborated = distinctSourceTypes >= 2;
  const meetsCandidateConfidence = rawConfidence >= CANDIDATE_MIN_CONFIDENCE;
  if (!corroborated || !meetsCandidateConfidence) {
    return { stage: "hypothesis", confidence: rawConfidence, status };
  }

  const isDurable = input.verified === true || (input.taskReferenceCount ?? 0) >= 2;
  if (isDurable) {
    return { stage: "durable", confidence: rawConfidence, status };
  }

  return {
    stage: "candidate",
    confidence: Math.min(rawConfidence, CANDIDATE_CONFIDENCE_CAP),
    status,
  };
}
