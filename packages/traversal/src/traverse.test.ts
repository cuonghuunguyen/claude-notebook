import { describe, expect, it } from "vitest";
import type { Edge, Node } from "@cognitive-memory/core";
import { DEFAULT_TRAVERSAL_BUDGET } from "@cognitive-memory/core";
import type { FrontierEdge, GraphProvider } from "./types.js";
import { traverse } from "./traverse.js";
import { createScriptedReasoner, expandAllReasoner } from "./scriptedReasoner.js";

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
    weight: 0.9,
    provenance: [],
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/**
 * In-memory stand-in for the real Postgres-backed GraphProvider
 * (frontier.ts) — mirrors `getFrontierEdges`'s contract exactly: given the
 * current frontier's node ids, return edges touching them whose OTHER
 * endpoint is not already in `excludeNeighborIds`.
 */
function createFixtureGraphProvider(nodes: Node[], edges: Edge[]): GraphProvider {
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  return {
    async getFrontier(nodeIds, excludeNeighborIds): Promise<FrontierEdge[]> {
      const nodeIdSet = new Set(nodeIds);
      const excludeSet = new Set(excludeNeighborIds);
      const result: FrontierEdge[] = [];
      for (const edge of edges) {
        if (edge.status !== "active") continue;
        const touches = nodeIdSet.has(edge.from) || nodeIdSet.has(edge.to);
        if (!touches) continue;
        const neighborId = nodeIdSet.has(edge.from) ? edge.to : edge.from;
        if (excludeSet.has(neighborId)) continue;
        result.push({ edge, neighborId });
      }
      return result;
    },
    async getNodes(ids): Promise<Node[]> {
      return ids.map((id) => nodesById.get(id)).filter((n): n is Node => n !== undefined);
    },
  };
}

describe("traverse", () => {
  it("terminates within budget even when a frontier is larger than maxNodes", async () => {
    // Star graph: seed "hub" fans out to 100 direct neighbors, all equally
    // attractive to the reasoner (which expands everything offered).
    const nodes = [makeNode("hub"), ...Array.from({ length: 100 }, (_, i) => makeNode(`spoke-${i}`))];
    const edges = nodes
      .filter((n) => n.id !== "hub")
      .map((n, i) => makeEdge(`e-${i}`, "hub", n.id));

    const result = await traverse(["hub"], "explore the hub", {
      graph: createFixtureGraphProvider(nodes, edges),
      reasoner: expandAllReasoner(),
      budget: { ...DEFAULT_TRAVERSAL_BUDGET, maxNodes: 5 },
    });

    expect(result.nodeIds.length).toBeLessThanOrEqual(5);
    expect(result.stopReason).toBe("budget_exhausted");
  });

  it("terminates once estimated token cost crosses maxTokens, even with budget to spare elsewhere", async () => {
    // Same star shape as the maxNodes test, but this time maxNodes/maxEdges
    // are generous and only maxTokens is tight — each spoke carries a long
    // summary so a handful of expansions is enough to cross a small cap.
    const longSummary = "x".repeat(400); // ~100 estimated tokens per node
    const nodes = [
      makeNode("hub"),
      ...Array.from({ length: 20 }, (_, i) => makeNode(`spoke-${i}`, { summary: longSummary })),
    ];
    const edges = nodes.filter((n) => n.id !== "hub").map((n, i) => makeEdge(`e-${i}`, "hub", n.id));

    const result = await traverse(["hub"], "explore the hub", {
      graph: createFixtureGraphProvider(nodes, edges),
      reasoner: expandAllReasoner(),
      budget: { ...DEFAULT_TRAVERSAL_BUDGET, maxNodes: 50, maxEdges: 50, maxTokens: 150 },
    });

    // 150 tokens / ~100 tokens per spoke leaves room for at most 2 spokes.
    expect(result.nodeIds.length).toBeLessThanOrEqual(3); // hub + at most 2 spokes
    expect(result.nodeIds.length).toBeGreaterThan(1); // budget wasn't zeroed out entirely
    expect(result.stopReason).toBe("budget_exhausted");
  });

  it("respects maxDepth even when every level offers more to expand", async () => {
    // Long chain, each node also has a couple of low-relevance dead ends the
    // scripted reasoner skips — enough frontier depth to run past maxDepth
    // if the budget weren't enforced.
    const chainLength = 10;
    const nodes = [makeNode("n0")];
    const edges: Edge[] = [];
    for (let i = 0; i < chainLength; i++) {
      nodes.push(makeNode(`n${i + 1}`));
      edges.push(makeEdge(`chain-${i}`, `n${i}`, `n${i + 1}`, { weight: 0.9 }));
      nodes.push(makeNode(`junk-${i}-a`));
      nodes.push(makeNode(`junk-${i}-b`));
      edges.push(makeEdge(`junk-${i}-a-e`, `n${i}`, `junk-${i}-a`, { weight: 0.1 }));
      edges.push(makeEdge(`junk-${i}-b-e`, `n${i}`, `junk-${i}-b`, { weight: 0.1 }));
    }

    const reasoner = createScriptedReasoner((context) => ({
      decisions: context.candidates.map((c) => ({
        edgeId: c.edgeId,
        action: c.edgeId.startsWith("chain-") ? "expand" : "skip",
      })),
      stop: false,
    }));

    const result = await traverse(["n0"], "walk the chain", {
      graph: createFixtureGraphProvider(nodes, edges),
      reasoner,
      budget: { ...DEFAULT_TRAVERSAL_BUDGET, maxDepth: 3, maxNodes: 50, maxReasoningSteps: 10 },
    });

    expect(result.depthReached).toBe(3);
    expect(result.stopReason).toBe("budget_exhausted");
    // Only the 3 chain hops should have been included, not the 6 skipped dead ends.
    expect(result.nodeIds.sort()).toEqual(["n0", "n1", "n2", "n3"].sort());
  });

  it("makes exactly one reasoning call per depth level, not one per edge (spec.md §10 batching)", async () => {
    // Same shape as the maxDepth test but with no depth ceiling reached —
    // the chain runs out of "chain-" edges after `chainLength` hops, so the
    // stop condition is natural exhaustion, isolating the call-count claim
    // from budget enforcement.
    const chainLength = 4;
    const nodes = [makeNode("n0")];
    const edges: Edge[] = [];
    for (let i = 0; i < chainLength; i++) {
      nodes.push(makeNode(`n${i + 1}`));
      edges.push(makeEdge(`chain-${i}`, `n${i}`, `n${i + 1}`, { weight: 0.9 }));
      nodes.push(makeNode(`junk-${i}-a`));
      nodes.push(makeNode(`junk-${i}-b`));
      edges.push(makeEdge(`junk-${i}-a-e`, `n${i}`, `junk-${i}-a`, { weight: 0.1 }));
      edges.push(makeEdge(`junk-${i}-b-e`, `n${i}`, `junk-${i}-b`, { weight: 0.1 }));
    }

    const reasoner = createScriptedReasoner((context) => ({
      decisions: context.candidates.map((c) => ({
        edgeId: c.edgeId,
        action: c.edgeId.startsWith("chain-") ? "expand" : "skip",
      })),
      stop: false,
    }));

    const result = await traverse(["n0"], "walk the chain", {
      graph: createFixtureGraphProvider(nodes, edges),
      reasoner,
      budget: { ...DEFAULT_TRAVERSAL_BUDGET, maxDepth: 10, maxNodes: 50, maxReasoningSteps: 10 },
    });

    const totalEdgesEncountered = edges.length; // 3 edges/level * chainLength
    expect(reasoner.callCount).toBe(chainLength);
    expect(result.depthReached).toBe(chainLength);
    expect(reasoner.callCount).toBeLessThan(totalEdgesEncountered);
    expect(result.stopReason).toBe("no_frontier"); // chain ran out, not a budget cutoff
  });

  it("stops immediately when the reasoner sets stop:true, without expanding further", async () => {
    const nodes = [makeNode("a"), makeNode("b"), makeNode("c")];
    const edges = [makeEdge("ab", "a", "b"), makeEdge("bc", "b", "c")];

    const reasoner = createScriptedReasoner((context) => ({
      decisions: context.candidates.map((c) => ({ edgeId: c.edgeId, action: "expand" })),
      stop: true,
    }));

    const result = await traverse(["a"], "task", {
      graph: createFixtureGraphProvider(nodes, edges),
      reasoner,
    });

    expect(reasoner.callCount).toBe(1);
    expect(result.stopReason).toBe("reasoner_stop");
    expect(result.nodeIds.sort()).toEqual(["a", "b"].sort());
  });

  it("returns no_frontier immediately for a seed with no edges", async () => {
    const nodes = [makeNode("isolated")];
    const result = await traverse(["isolated"], "task", {
      graph: createFixtureGraphProvider(nodes, []),
      reasoner: expandAllReasoner(),
    });
    expect(result.stopReason).toBe("no_frontier");
    expect(result.nodeIds).toEqual(["isolated"]);
  });
});
