import { afterEach, describe, expect, it, vi } from "vitest";
import type { Edge, Experience, Node } from "@cognitive-memory/core";

/**
 * `runPipeline` calls three functions that are hardcoded module imports,
 * not injected parameters (per spec.md §22 — only `embedder`/`graph`/
 * `reasoner` are injected): `retrieveSeeds` (retrieval), `getNodesByIds`
 * (graph-store), and `queryByNode` (episodic). Each hits real Postgres in
 * its real implementation, same as traversal's own `createPostgresGraphProvider`
 * does for the (separately, properly injected) `GraphProvider`. To keep
 * this suite DB-free — the acceptance criterion's whole point, contrasted
 * with `pipeline.integration.test.ts` below — those three module boundaries
 * are mocked here; `graph`/`reasoner`/`embedder` are exercised via real
 * fixture implementations, same pattern M2/M5's own unit suites use.
 */
vi.mock("@cognitive-memory/retrieval", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cognitive-memory/retrieval")>()),
  retrieveSeeds: vi.fn(),
}));
vi.mock("@cognitive-memory/graph-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cognitive-memory/graph-store")>()),
  getNodesByIds: vi.fn(),
}));
vi.mock("@cognitive-memory/episodic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cognitive-memory/episodic")>()),
  queryByNode: vi.fn(),
}));

import { queryByNode } from "@cognitive-memory/episodic";
import { getNodesByIds } from "@cognitive-memory/graph-store";
import { retrieveSeeds } from "@cognitive-memory/retrieval";
import type { EmbeddingProvider, SeedNode } from "@cognitive-memory/retrieval";
import type { FrontierEdge, GraphProvider } from "@cognitive-memory/traversal";
import { expandAllReasoner } from "@cognitive-memory/traversal";
import { runPipeline } from "./pipeline.js";

const mockRetrieveSeeds = vi.mocked(retrieveSeeds);
const mockGetNodesByIds = vi.mocked(getNodesByIds);
const mockQueryByNode = vi.mocked(queryByNode);

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

/** Same in-memory fixture shape as traversal's own traverse.test.ts. */
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

afterEach(() => {
  vi.clearAllMocks();
});

describe("runPipeline", () => {
  it("composes retrieveSeeds -> traverse -> hydration -> buildContext in one call", async () => {
    const seed: SeedNode = { nodeId: "svc", score: 0.9, reason: "lexical_match" };
    mockRetrieveSeeds.mockResolvedValue([seed]);

    const nodes = [
      makeNode("svc", { type: "subsystem", name: "PaymentService" }),
      makeNode("repo", { type: "file", path: "src/paymentRepository.ts", name: "PaymentRepository" }),
    ];
    const edges = [makeEdge("e1", "svc", "repo", { relation: "calls", weight: 0.8 })];
    mockGetNodesByIds.mockResolvedValue(nodes);

    const experience = makeExperience("exp-1", {
      task: "fix payment bug",
      lessons: ["always persist before publishing"],
      relatedNodes: ["svc"],
    });
    mockQueryByNode.mockImplementation(async (nodeId) => (nodeId === "svc" ? [experience] : []));

    const result = await runPipeline("how does PaymentService persist a payment", {
      graph: createFixtureGraphProvider(nodes, edges),
      reasoner: expandAllReasoner(),
    });

    expect(result.seeds).toEqual([seed]);
    expect(result.traversal.nodeIds.sort()).toEqual(["repo", "svc"].sort());
    expect(result.context.subsystems).toEqual([{ nodeId: "svc", name: "PaymentService", summary: undefined }]);
    expect(result.context.sourceFiles).toEqual([
      { nodeId: "repo", path: "src/paymentRepository.ts", summary: undefined },
    ]);
    expect(result.context.relationships).toEqual([
      {
        edgeId: "e1",
        relation: "calls",
        from: { id: "svc", name: "PaymentService" },
        to: { id: "repo", name: "PaymentRepository" },
        confidence: 1,
        weight: 0.8,
      },
    ]);
    expect(result.context.experiences).toEqual([
      { experienceId: "exp-1", task: "fix payment bug", lessons: ["always persist before publishing"], result: undefined },
    ]);
  });

  it("short-circuits on an empty seed set: never calls traverse's graph/reasoner, returns an empty AgentContext", async () => {
    mockRetrieveSeeds.mockResolvedValue([]);
    const graph = createFixtureGraphProvider([], []);
    const getFrontierSpy = vi.spyOn(graph, "getFrontier");
    const reasoner = expandAllReasoner();

    const result = await runPipeline("a task nothing in the graph matches yet", {
      graph,
      reasoner,
    });

    expect(result.seeds).toEqual([]);
    expect(result.traversal).toEqual({
      nodeIds: [],
      edges: [],
      depthReached: 0,
      reasoningStepsUsed: 0,
      stopReason: "no_frontier",
    });
    expect(result.context).toEqual({
      task: "a task nothing in the graph matches yet",
      subsystems: [],
      relationships: [],
      invariants: [],
      experiences: [],
      sourceFiles: [],
    });
    expect(getFrontierSpy).not.toHaveBeenCalled();
    expect(reasoner.callCount).toBe(0);
    expect(mockGetNodesByIds).not.toHaveBeenCalled();
    expect(mockQueryByNode).not.toHaveBeenCalled();
  });

  it("truncates hydrated experiences to maxExperiences, keeping the most recent", async () => {
    mockRetrieveSeeds.mockResolvedValue([{ nodeId: "svc", score: 0.5, reason: "lexical_match" }]);
    const nodes = [makeNode("svc")];
    mockGetNodesByIds.mockResolvedValue(nodes);

    const older = makeExperience("old", { timestamp: "2020-01-01T00:00:00.000Z" });
    const newer = makeExperience("new", { timestamp: "2024-01-01T00:00:00.000Z" });
    mockQueryByNode.mockResolvedValue([older, newer]);

    const result = await runPipeline("task", {
      graph: createFixtureGraphProvider(nodes, []),
      reasoner: expandAllReasoner(),
      maxExperiences: 1,
      contextOptions: { maxExperiences: 5 },
    });

    expect(result.context.experiences).toHaveLength(1);
    expect(result.context.experiences[0]?.experienceId).toBe("new");
  });

  it("re-sorts hydrated nodes back into traversal's priority order before buildContext truncates (getNodesByIds has no ORDER BY)", async () => {
    mockRetrieveSeeds.mockResolvedValue([{ nodeId: "fileA", score: 0.9, reason: "lexical_match" }]);

    const fileA = makeNode("fileA", { type: "file", path: "/src/a.ts" });
    const fileB = makeNode("fileB", { type: "file", path: "/src/b.ts" });
    // getNodesByIds resolves in the OPPOSITE order from traversal.nodeIds
    // ([fileA, fileB]) — exactly the real function's documented lack of an
    // ORDER BY guarantee.
    mockGetNodesByIds.mockResolvedValue([fileB, fileA]);
    mockQueryByNode.mockResolvedValue([]);

    const graph = createFixtureGraphProvider([fileA, fileB], [makeEdge("e1", "fileA", "fileB", { weight: 0.9 })]);

    const result = await runPipeline("task", {
      graph,
      reasoner: expandAllReasoner(),
      // Force truncation to 1 so only the higher-priority node survives.
      contextOptions: { maxSourceFiles: 1 },
    });

    expect(result.traversal.nodeIds).toEqual(["fileA", "fileB"]);
    // fileA was discovered first (it's the seed) — it must be the one kept,
    // not fileB, regardless of getNodesByIds's return order.
    expect(result.context.sourceFiles).toEqual([{ nodeId: "fileA", path: "/src/a.ts", summary: undefined }]);
  });
});

describe("runPipeline shared embedding", () => {
  it("calls embed() exactly once per invocation, reusing it for both retrieval and traversal", async () => {
    mockRetrieveSeeds.mockResolvedValue([{ nodeId: "svc", score: 0.5, reason: "semantic_match" }]);
    const nodes = [makeNode("svc")];
    mockGetNodesByIds.mockResolvedValue(nodes);
    mockQueryByNode.mockResolvedValue([]);

    const embed = vi.fn(async () => [1, 0, 0]);
    const embedder: EmbeddingProvider = { embed };

    await runPipeline("task", {
      graph: createFixtureGraphProvider(nodes, []),
      reasoner: expandAllReasoner(),
      embedder,
    });

    expect(embed).toHaveBeenCalledTimes(1);
    // retrieveSeeds must have received a provider (the cached shim), not undefined.
    const passedOptions = mockRetrieveSeeds.mock.calls[0]?.[1];
    expect(passedOptions?.embedder).toBeDefined();
    expect(passedOptions?.embedder).not.toBe(embedder);
  });
});
