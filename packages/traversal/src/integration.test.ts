import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Edge, Node } from "@cognitive-memory/core";
import {
  closePool,
  getEdgeByTriple,
  markNodeDeleted,
  runMigrations,
  upsertEdgeByTriple,
  upsertNode,
} from "@cognitive-memory/graph-store";
import { createPostgresGraphProvider } from "./frontier.js";
import { expandAllReasoner } from "./scriptedReasoner.js";
import { traverse } from "./traverse.js";

// Same DATABASE_URL-gating convention as every other integration suite in
// this repo — skipped, not failed, without a real Postgres.
const hasDb = Boolean(process.env["DATABASE_URL"]);
const d = hasDb ? describe : describe.skip;

function makeNode(id: string, overrides: Partial<Node>): Node {
  const now = new Date().toISOString();
  return {
    id,
    type: "class",
    metadata: {},
    provenance: [{ sourceType: "source_code", sourceId: id, confidence: 1, observedAt: now }],
    status: "active",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeEdge(from: string, to: string, overrides: Partial<Edge>): Edge {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    from,
    to,
    relation: "calls",
    confidence: 1,
    weight: 0.5,
    provenance: [],
    status: "active",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

d("traversal integration", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await closePool();
  });

  it("expands from a seed node through real Postgres-backed frontier queries", async () => {
    const repoId = `traversal-test-${randomUUID()}`;
    const serviceId = `${repoId}-payment-service`;
    const repoMethodId = `${repoId}-repository-method`;
    const unrelatedId = `${repoId}-date-formatter`;

    await upsertNode(makeNode(serviceId, { name: "PaymentService" }), repoId);
    await upsertNode(
      makeNode(repoMethodId, { type: "method", name: "save", summary: "Persists a payment record." }),
      repoId
    );
    await upsertNode(makeNode(unrelatedId, { type: "class", name: "DateFormatter" }), repoId);

    await upsertEdgeByTriple(
      makeEdge(serviceId, repoMethodId, { relation: "calls", weight: 0.9 })
    );
    await upsertEdgeByTriple(
      makeEdge(serviceId, unrelatedId, { relation: "imports", weight: 0.2 })
    );

    const result = await traverse(
      [serviceId],
      "how does PaymentService persist a payment record",
      {
        graph: createPostgresGraphProvider(),
        reasoner: expandAllReasoner(),
        budget: { maxDepth: 2, maxNodes: 10, maxEdges: 10, maxReasoningSteps: 3, maxTokens: 8000 },
      }
    );

    expect(result.nodeIds).toContain(serviceId);
    expect(result.nodeIds).toContain(repoMethodId);
    expect(result.nodeIds).toContain(unrelatedId);
    expect(result.stopReason).not.toBe("budget_exhausted");
  });

  it("never re-offers an already-visited node as a frontier candidate", async () => {
    const repoId = `traversal-test-${randomUUID()}`;
    const aId = `${repoId}-a`;
    const bId = `${repoId}-b`;

    await upsertNode(makeNode(aId, { name: "A" }), repoId);
    await upsertNode(makeNode(bId, { name: "B" }), repoId);
    // A cycle: a -> b and b -> a.
    await upsertEdgeByTriple(makeEdge(aId, bId, { relation: "calls", weight: 0.8 }));
    await upsertEdgeByTriple(makeEdge(bId, aId, { relation: "calls", weight: 0.8 }));

    const result = await traverse([aId], "task", {
      graph: createPostgresGraphProvider(),
      reasoner: expandAllReasoner(),
      budget: { maxDepth: 5, maxNodes: 10, maxEdges: 10, maxReasoningSteps: 5, maxTokens: 8000 },
    });

    expect(result.nodeIds.sort()).toEqual([aId, bId].sort());
    // Only the a->b edge should ever be offered — b->a's neighbor (a) is
    // already visited by the time b's frontier is fetched.
    expect(result.edges).toHaveLength(1);
  });

  it("lazily verifies stale edges (spec.md §12): a still-live one rejoins as active, a dead one drops from the frontier", async () => {
    const repoId = `traversal-test-${randomUUID()}`;
    const seedId = `${repoId}-seed`;
    const liveNeighborId = `${repoId}-live-neighbor`;
    const deadNeighborId = `${repoId}-dead-neighbor`;

    await upsertNode(makeNode(seedId, { name: "Seed" }), repoId);
    await upsertNode(makeNode(liveNeighborId, { name: "LiveNeighbor" }), repoId);
    await upsertNode(makeNode(deadNeighborId, { name: "DeadNeighbor" }), repoId);
    await markNodeDeleted(deadNeighborId);

    const liveEdge = await upsertEdgeByTriple(
      makeEdge(seedId, liveNeighborId, { relation: "depends_on", weight: 0.9, status: "stale" })
    );
    await upsertEdgeByTriple(
      makeEdge(seedId, deadNeighborId, { relation: "depends_on", weight: 0.9, status: "stale" })
    );

    const result = await traverse([seedId], "task", {
      graph: createPostgresGraphProvider(),
      reasoner: expandAllReasoner(),
      budget: { maxDepth: 2, maxNodes: 10, maxEdges: 10, maxReasoningSteps: 2, maxTokens: 8000 },
    });

    // Only the live neighbor's edge survives verification and gets offered
    // to the reasoner; the dead one is dropped before ranking ever sees it.
    expect(result.nodeIds).toContain(liveNeighborId);
    expect(result.nodeIds).not.toContain(deadNeighborId);

    const refreshed = await getEdgeByTriple(seedId, liveNeighborId, "depends_on");
    expect(refreshed?.status).toBe("active");
    expect(refreshed?.lastVerifiedAt).toBeTruthy();

    const invalidated = await getEdgeByTriple(seedId, deadNeighborId, "depends_on");
    expect(invalidated?.status).toBe("invalid");
    expect(liveEdge.status).toBe("stale"); // sanity: the fixture really started stale
  });
});
