import type { Provenance, ProvenanceSourceType } from "@cognitive-memory/core";
import { EVIDENCE_HIERARCHY } from "@cognitive-memory/core";

/**
 * Two provenance records of the SAME sourceType (so the evidence hierarchy
 * has no basis to prefer one) whose confidence differs by more than this are
 * a genuine disagreement, not measurement noise — spec.md §13: "if conflict
 * cannot be resolved by the hierarchy: status = disputed." Different
 * sourceTypes never tie (EVIDENCE_HIERARCHY gives every type a distinct
 * rank), so a tie can only happen within one sourceType.
 */
const DISPUTE_CONFIDENCE_DELTA = 0.2;

function hierarchyRank(sourceType: ProvenanceSourceType): number {
  const rank = EVIDENCE_HIERARCHY.indexOf(sourceType);
  if (rank === -1) throw new Error(`confidence: unranked provenance sourceType "${sourceType}"`);
  return rank;
}

/** Higher-trust tiers dominate the average; 2^k spacing so a source_code fact isn't meaningfully moved by an llm_inference one. */
function hierarchyWeight(sourceType: ProvenanceSourceType): number {
  return 2 ** (EVIDENCE_HIERARCHY.length - 1 - hierarchyRank(sourceType));
}

export interface ResolvedConfidence {
  /** Evidence-hierarchy-weighted average across all provided provenance (spec.md §7's "candidate" formula, reused here as the general combination rule). */
  confidence: number;
  /** True when the most-trusted sourceType present has ≥2 records that disagree beyond DISPUTE_CONFIDENCE_DELTA — the hierarchy can't pick a winner among equally-ranked facts (spec.md §13). */
  disputed: boolean;
}

/**
 * Combines a triple's provenance into one confidence value + dispute flag
 * (spec.md §13). A hierarchy-weighted average — rather than a plain average
 * or max — so a highly-trusted but lower-confidence source_code fact isn't
 * outvoted by a less-trusted but higher-confidence llm_inference one: with
 * exponential tier weighting, the top-ranked source's value dominates the
 * result, which is the practical effect of spec.md's "Fact A wins" example.
 */
export function resolveConfidence(provenance: readonly Provenance[]): ResolvedConfidence {
  if (provenance.length === 0) return { confidence: 0, disputed: false };

  let weightedSum = 0;
  let weightTotal = 0;
  for (const p of provenance) {
    const w = hierarchyWeight(p.sourceType);
    weightedSum += w * p.confidence;
    weightTotal += w;
  }
  const confidence = weightedSum / weightTotal;

  const topRank = Math.min(...provenance.map((p) => hierarchyRank(p.sourceType)));
  const topTierConfidences = provenance
    .filter((p) => hierarchyRank(p.sourceType) === topRank)
    .map((p) => p.confidence);
  const disputed =
    topTierConfidences.length > 1 &&
    Math.max(...topTierConfidences) - Math.min(...topTierConfidences) > DISPUTE_CONFIDENCE_DELTA;

  return { confidence, disputed };
}
