import { describe, expect, it } from "vitest";
import type { Provenance } from "@cognitive-memory/core";
import { resolveConfidence } from "./confidence.js";

function prov(sourceType: Provenance["sourceType"], confidence: number, sourceId = "s"): Provenance {
  return { sourceType, sourceId, confidence, observedAt: "2024-01-01T00:00:00.000Z" };
}

describe("resolveConfidence (spec.md §13)", () => {
  it("a single provenance record resolves to its own confidence, undisputed", () => {
    const result = resolveConfidence([prov("source_code", 0.8)]);
    expect(result.confidence).toBeCloseTo(0.8);
    expect(result.disputed).toBe(false);
  });

  it("spec.md §13's exact example: source_code@0.8 vs llm_inference@0.95 resolves toward the more trusted source, not the raw higher confidence", () => {
    const result = resolveConfidence([prov("source_code", 0.8), prov("llm_inference", 0.95)]);
    // "Fact A wins" — the result must be dominated by source_code's 0.8, not
    // pulled toward llm_inference's 0.95 (a plain average would land at
    // 0.875; picking the raw-higher value would give 0.95 — both wrong).
    expect(result.confidence).toBeLessThan(0.85);
    expect(result.confidence).toBeGreaterThan(0.75);
    expect(result.disputed).toBe(false); // different sourceTypes always have distinct hierarchy ranks — never a tie
  });

  it("two same-sourceType facts with meaningfully different confidence are disputed — hierarchy has no basis to prefer one", () => {
    const result = resolveConfidence([prov("source_code", 0.9, "a"), prov("source_code", 0.3, "b")]);
    expect(result.disputed).toBe(true);
  });

  it("two same-sourceType facts with close confidence are not disputed", () => {
    const result = resolveConfidence([prov("source_code", 0.9, "a"), prov("source_code", 0.85, "b")]);
    expect(result.disputed).toBe(false);
  });

  it("a lower-ranked sourceType tying with itself doesn't get compared against the higher-ranked tier", () => {
    // Two conflicting llm_inference facts (bottom tier) plus one clean
    // source_code fact (top tier, unique) — the dispute check only looks at
    // the TOP tier, which has a single record, so this is not disputed.
    const result = resolveConfidence([
      prov("source_code", 0.9),
      prov("llm_inference", 0.9, "a"),
      prov("llm_inference", 0.1, "b"),
    ]);
    expect(result.disputed).toBe(false);
  });
});
