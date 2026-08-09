import { describe, expect, it } from "vitest";
import type { Edge, Node } from "@cognitive-memory/core";
import { scoreCandidate } from "./ranking.js";

const NOW = new Date().toISOString();

function makeNode(overrides: Partial<Node>): Node {
  return {
    id: "n",
    type: "function",
    metadata: {},
    provenance: [],
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeEdge(overrides: Partial<Edge>): Edge {
  return {
    id: "e",
    from: "a",
    to: "b",
    relation: "references",
    confidence: 1,
    weight: 1,
    provenance: [],
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("scoreCandidate", () => {
  it("multiplies confidence and weight rather than adding them (spec.md §3.3)", () => {
    const highImportanceLowConfidence = scoreCandidate({
      edge: makeEdge({ confidence: 0.1, weight: 1.0 }),
      neighborNode: makeNode({}),
      task: "",
      depth: 1,
    });
    const highConfidenceLowImportance = scoreCandidate({
      edge: makeEdge({ confidence: 1.0, weight: 0.1 }),
      neighborNode: makeNode({}),
      task: "",
      depth: 1,
    });
    // Same product (0.1) either way, so with all other inputs held equal the
    // two scores must be identical — proving the term is confidence*weight,
    // not confidence+weight (which would make the two 1.1 vs 1.1 too, so the
    // real discriminator below is against a case additive combination would
    // conflate but multiplication would not).
    // Precision 6 (tolerance 5e-7), not the default or something tighter:
    // the two scores are built by summing several independently-computed
    // terms (lookup-table lengths, string ops, etc.), so bit-identical
    // floating-point equality isn't guaranteed even when the two paths are
    // mathematically equal — 10 was tight enough to flake on ~3.9e-10 of
    // float noise while proving nothing an engineering tolerance doesn't.
    expect(highImportanceLowConfidence).toBeCloseTo(highConfidenceLowImportance, 6);

    const bothMid = scoreCandidate({
      edge: makeEdge({ confidence: 0.5, weight: 0.5 }),
      neighborNode: makeNode({}),
      task: "",
      depth: 1,
    });
    // confidence*weight: 0.1 vs 0.25 — bothMid must score higher.
    // confidence+weight (both 1.1 sum for the extremes vs 1.0 sum for mid)
    // would instead rank bothMid LOWER, so this assertion distinguishes the
    // two combination rules.
    expect(bothMid).toBeGreaterThan(highImportanceLowConfidence);
  });

  it("ranks a must_follow invariant edge above a references edge, all else equal", () => {
    const mustFollow = scoreCandidate({
      edge: makeEdge({ relation: "must_follow" }),
      neighborNode: makeNode({ type: "invariant" }),
      task: "",
      depth: 1,
    });
    const references = scoreCandidate({
      edge: makeEdge({ relation: "references" }),
      neighborNode: makeNode({ type: "invariant" }),
      task: "",
      depth: 1,
    });
    expect(mustFollow).toBeGreaterThan(references);
  });

  it("rewards lexical overlap between task and node name/summary", () => {
    const relevant = scoreCandidate({
      edge: makeEdge({}),
      neighborNode: makeNode({ name: "PaymentValidator", summary: "Validates payment amounts" }),
      task: "how does payment validation work",
      depth: 1,
    });
    const irrelevant = scoreCandidate({
      edge: makeEdge({}),
      neighborNode: makeNode({ name: "DateFormatter", summary: "Formats dates for display" }),
      task: "how does payment validation work",
      depth: 1,
    });
    expect(relevant).toBeGreaterThan(irrelevant);
  });

  it("penalizes deeper depth levels via traversal_cost", () => {
    const shallow = scoreCandidate({ edge: makeEdge({}), neighborNode: makeNode({}), task: "", depth: 1 });
    const deep = scoreCandidate({ edge: makeEdge({}), neighborNode: makeNode({}), task: "", depth: 5 });
    expect(deep).toBeLessThan(shallow);
  });

  it("rewards recently-updated edges over stale ones", () => {
    const fresh = scoreCandidate({
      edge: makeEdge({ updatedAt: new Date().toISOString() }),
      neighborNode: makeNode({}),
      task: "",
      depth: 1,
    });
    const old = scoreCandidate({
      edge: makeEdge({ updatedAt: new Date(Date.now() - 365 * 86_400_000).toISOString() }),
      neighborNode: makeNode({}),
      task: "",
      depth: 1,
    });
    expect(fresh).toBeGreaterThan(old);
  });

  it("adds semantic_relevance from taskEmbedding/node embedding cosine similarity when both are present", () => {
    const withEmbeddings = scoreCandidate({
      edge: makeEdge({}),
      neighborNode: makeNode({ metadata: { embedding: [1, 0, 0] } }),
      task: "",
      depth: 1,
      taskEmbedding: [1, 0, 0],
    });
    const withoutEmbeddings = scoreCandidate({
      edge: makeEdge({}),
      neighborNode: makeNode({}),
      task: "",
      depth: 1,
    });
    expect(withEmbeddings).toBeGreaterThan(withoutEmbeddings);
  });
});
