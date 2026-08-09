import { describe, expect, it } from "vitest";
import type { Node } from "@cognitive-memory/core";
import type { NodeSearchHit } from "@cognitive-memory/graph-store";
import { mergeHits } from "./merge.js";

function fakeNode(id: string): Node {
  return {
    id,
    type: "function",
    metadata: {},
    provenance: [],
    status: "active",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
}

function hit(id: string, score: number): NodeSearchHit {
  return { node: fakeNode(id), score };
}

describe("mergeHits", () => {
  it("tags a lexical-only hit as lexical_match", () => {
    const merged = mergeHits([hit("a", 0.5)], []);
    expect(merged).toEqual([{ nodeId: "a", score: 0.5, reason: "lexical_match" }]);
  });

  it("tags a vector-only hit as semantic_match", () => {
    const merged = mergeHits([], [hit("a", 0.7)]);
    expect(merged).toEqual([{ nodeId: "a", score: 0.7, reason: "semantic_match" }]);
  });

  it("tags a node hit by both legs as hybrid_match, scored by the stronger leg", () => {
    const merged = mergeHits([hit("a", 0.4)], [hit("a", 0.9)]);
    expect(merged).toEqual([{ nodeId: "a", score: 0.9, reason: "hybrid_match" }]);
  });

  it("de-dupes and ranks by score descending", () => {
    const merged = mergeHits([hit("a", 0.3), hit("b", 0.9)], [hit("a", 0.3)]);
    expect(merged.map((m) => m.nodeId)).toEqual(["b", "a"]);
    expect(merged.find((m) => m.nodeId === "a")?.reason).toBe("hybrid_match");
  });
});
