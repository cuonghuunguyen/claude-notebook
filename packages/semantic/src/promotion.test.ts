import { describe, expect, it } from "vitest";
import type { Provenance } from "@cognitive-memory/core";
import { computePromotion } from "./promotion.js";

function prov(sourceType: Provenance["sourceType"], confidence: number, sourceId = "s"): Provenance {
  return { sourceType, sourceId, confidence, observedAt: "2024-01-01T00:00:00.000Z" };
}

describe("computePromotion (spec.md §7 promotion table)", () => {
  it("a single provenance record is an observation, not a candidate", () => {
    const result = computePromotion({ provenance: [prov("source_code", 0.9)] });
    expect(result.stage).toBe("observation");
    expect(result.status).toBe("active");
  });

  it("≥2 observations of the SAME sourceType stay a hypothesis — no diversity to corroborate with", () => {
    const result = computePromotion({
      provenance: [prov("llm_inference", 0.6, "pass-1"), prov("llm_inference", 0.6, "pass-2")],
    });
    expect(result.stage).toBe("hypothesis");
  });

  it("2 observations from 2 distinct sourceTypes reach candidate, confidence capped at 0.75", () => {
    const result = computePromotion({
      provenance: [prov("source_code", 0.9), prov("git_commit", 0.9)],
    });
    expect(result.stage).toBe("candidate");
    expect(result.confidence).toBeLessThanOrEqual(0.75);
  });

  it("a verification pass unlocks durable, confidence no longer capped at 0.75", () => {
    const result = computePromotion({
      provenance: [prov("source_code", 0.95), prov("git_commit", 0.95)],
      verified: true,
    });
    expect(result.stage).toBe("durable");
    expect(result.confidence).toBeGreaterThan(0.75);
  });

  it("≥2 separate task references without contradiction is the alternate durable path", () => {
    const result = computePromotion({
      provenance: [prov("source_code", 0.95), prov("git_commit", 0.95)],
      taskReferenceCount: 2,
    });
    expect(result.stage).toBe("durable");
    expect(result.confidence).toBeGreaterThan(0.75);
  });

  it("a single task reference isn't enough for durable — stays candidate", () => {
    const result = computePromotion({
      provenance: [prov("source_code", 0.95), prov("git_commit", 0.95)],
      taskReferenceCount: 1,
    });
    expect(result.stage).toBe("candidate");
  });

  it("spec.md §13's exact example resolves per the hierarchy, not raw confidence, and reaches candidate (not disputed)", () => {
    const result = computePromotion({
      provenance: [prov("source_code", 0.8), prov("llm_inference", 0.95)],
    });
    expect(result.status).toBe("active");
    expect(result.stage).toBe("candidate");
    // Capped at 0.75 by the candidate stage, but the underlying resolution
    // (tested directly in confidence.test.ts) is what proves source_code's
    // 0.8 dominates rather than llm_inference's 0.95.
    expect(result.confidence).toBeLessThanOrEqual(0.75);
  });

  it("a same-sourceType tie at the top-ranked tier is disputed", () => {
    const result = computePromotion({
      provenance: [prov("source_code", 0.9, "a"), prov("source_code", 0.2, "b")],
    });
    expect(result.status).toBe("disputed");
  });

  it("2 distinct sourceTypes with low confidence stay a hypothesis — diversity alone isn't enough", () => {
    const result = computePromotion({
      provenance: [prov("source_code", 0.1), prov("git_commit", 0.1)],
    });
    expect(result.stage).toBe("hypothesis");
    expect(result.confidence).toBeLessThan(0.5);
  });
});
