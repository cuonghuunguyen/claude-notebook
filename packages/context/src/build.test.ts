import { describe, expect, it } from "vitest";
import type { Edge, Experience, Node } from "@cognitive-memory/core";
import { buildContext } from "./build.js";
import type { Subgraph } from "./types.js";

const NOW = new Date().toISOString();

function makeNode(id: string, overrides: Partial<Node> = {}): Node {
  return {
    id,
    type: "function",
    metadata: {},
    provenance: [],
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeEdge(id: string, from: string, to: string, overrides: Partial<Edge> = {}): Edge {
  return {
    id,
    from,
    to,
    relation: "calls",
    confidence: 1,
    weight: 0.5,
    provenance: [],
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeExperience(id: string, overrides: Partial<Experience> = {}): Experience {
  return {
    id,
    task: "task",
    observation: "observation",
    relatedNodes: [],
    confidence: 0.5,
    timestamp: NOW,
    ...overrides,
  };
}

describe("buildContext", () => {
  it("groups nodes into their sections by NodeType", () => {
    const subgraph: Subgraph = {
      nodes: [
        makeNode("sub-1", { type: "subsystem", name: "Payments" }),
        makeNode("file-1", { type: "file", path: "src/a.ts" }),
        makeNode("inv-1", { type: "invariant", name: "no dup writes" }),
        makeNode("fn-1", { type: "function", name: "save" }),
      ],
      edges: [],
    };

    const context = buildContext(subgraph, "task");

    expect(context.subsystems).toEqual([{ nodeId: "sub-1", name: "Payments", summary: undefined }]);
    expect(context.invariants).toEqual([{ nodeId: "inv-1", name: "no dup writes", summary: undefined }]);
    expect(context.sourceFiles).toEqual([{ nodeId: "file-1", path: "src/a.ts", summary: undefined }]);
    // "fn-1" belongs to none of the three typed sections and isn't dropped
    // silently — it's just not represented outside the relationships it
    // participates in, which this fixture gives it none of.
  });

  it("resolves relationship endpoint names from the node set and falls back to the raw id when a node is missing", () => {
    const subgraph: Subgraph = {
      nodes: [makeNode("a", { name: "A" })],
      edges: [makeEdge("e1", "a", "missing-node", { relation: "calls" })],
    };

    const context = buildContext(subgraph, "task");

    expect(context.relationships).toEqual([
      {
        edgeId: "e1",
        relation: "calls",
        from: { id: "a", name: "A" },
        to: { id: "missing-node", name: "missing-node" },
        confidence: 1,
        weight: 0.5,
      },
    ]);
  });

  it("drops invalid edges from the relationships section", () => {
    const subgraph: Subgraph = {
      nodes: [makeNode("a"), makeNode("b")],
      edges: [
        makeEdge("valid", "a", "b", { status: "active" }),
        makeEdge("invalid", "a", "b", { status: "invalid" }),
      ],
    };

    const context = buildContext(subgraph, "task");

    expect(context.relationships.map((r) => r.edgeId)).toEqual(["valid"]);
  });

  it("orders relationships by weight descending, then edge id for ties", () => {
    const subgraph: Subgraph = {
      nodes: [makeNode("a"), makeNode("b")],
      edges: [
        makeEdge("low", "a", "b", { weight: 0.2 }),
        makeEdge("high", "a", "b", { weight: 0.9 }),
        makeEdge("tie-b", "a", "b", { weight: 0.5 }),
        makeEdge("tie-a", "a", "b", { weight: 0.5 }),
      ],
    };

    const context = buildContext(subgraph, "task");

    expect(context.relationships.map((r) => r.edgeId)).toEqual(["high", "tie-a", "tie-b", "low"]);
  });

  it("orders prior experience by timestamp descending (most recent lesson first)", () => {
    const subgraph: Subgraph = {
      nodes: [],
      edges: [],
      experiences: [
        makeExperience("old", { timestamp: "2026-01-01T00:00:00.000Z" }),
        makeExperience("new", { timestamp: "2026-03-01T00:00:00.000Z" }),
      ],
    };

    const context = buildContext(subgraph, "task");

    expect(context.experiences.map((e) => e.experienceId)).toEqual(["new", "old"]);
  });

  it("caps by the subgraph's own node order (the caller's priority signal), not by alphabetical sort", () => {
    // "aaa-low-priority" sorts first alphabetically but is listed LAST by the
    // caller (e.g. traversal visited it late, at a lower rank); the cap must
    // keep the two nodes the caller put first, not the two that sort first.
    const nodes = [
      makeNode("inv-first", { type: "invariant", name: "zzz-first" }),
      makeNode("inv-second", { type: "invariant", name: "yyy-second" }),
      makeNode("inv-third", { type: "invariant", name: "aaa-low-priority" }),
    ];
    const subgraph: Subgraph = { nodes, edges: [] };

    const context = buildContext(subgraph, "task", { maxInvariants: 2 });

    expect(context.invariants.map((i) => i.nodeId)).toEqual(["inv-second", "inv-first"]); // kept, then sorted alphabetically for display
  });

  it("returns empty sections for an empty subgraph rather than throwing", () => {
    const context = buildContext({ nodes: [], edges: [] }, "task");

    expect(context).toEqual({
      task: "task",
      subsystems: [],
      relationships: [],
      invariants: [],
      experiences: [],
      sourceFiles: [],
    });
  });
});
