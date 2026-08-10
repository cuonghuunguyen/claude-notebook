import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Edge, Node } from "@cognitive-memory/core";
import {
  closePool,
  runMigrations,
  upsertEdgeByTriple,
  upsertNode,
} from "@cognitive-memory/graph-store";
import { recordExperience } from "@cognitive-memory/episodic";
import { createFakeEmbedder } from "@cognitive-memory/retrieval";
import { createPostgresGraphProvider, expandAllReasoner } from "@cognitive-memory/traversal";
import { runPipeline } from "./pipeline.js";

// Same DATABASE_URL-gating convention as every other integration suite in
// this repo — skipped, not failed, without a real Postgres.
const hasDb = Boolean(process.env["DATABASE_URL"]);
const d = hasDb ? describe : describe.skip;

function makeNode(id: string, overrides: Partial<Node> = {}): Node {
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

function makeEdge(from: string, to: string, overrides: Partial<Edge> = {}): Edge {
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

d("runPipeline integration", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await closePool();
  });

  it("goes from a task string to an AgentContext matching the fixture's real structural graph (spec.md §22 — the actual point of this milestone)", async () => {
    const repoId = `pipeline-test-${randomUUID()}`;
    const svcId = `${repoId}-payment-service`;
    const fileId = `${repoId}-payment-repository-file`;
    const unrelatedId = `${repoId}-date-formatter`;

    await upsertNode(makeNode(svcId, { type: "subsystem", name: "PaymentService" }), repoId);
    // Deliberately no lexical overlap with "PaymentService" — it must only
    // be reachable via traversal's edge expansion, not retrieval's own
    // lexical leg or 1-hop seed expansion (spec.md §9), so this test
    // actually isolates traversal's contribution to the final context.
    await upsertNode(
      makeNode(fileId, { type: "file", path: "/src/storageAdapter.ts", name: "StorageAdapterModule" }),
      repoId
    );
    await upsertNode(makeNode(unrelatedId, { type: "class", name: "DateFormatter" }), repoId);

    await upsertEdgeByTriple(makeEdge(svcId, fileId, { relation: "calls", weight: 0.9 }));
    await upsertEdgeByTriple(makeEdge(svcId, unrelatedId, { relation: "imports", weight: 0.1 }));

    const { context, seeds, traversal } = await runPipeline("PaymentService", {
      repoId,
      graph: createPostgresGraphProvider(),
      reasoner: expandAllReasoner(),
      // Disable retrieval's own 1-hop seed expansion (spec.md §9) so this
      // test isolates traversal's contribution — otherwise fileId would
      // already arrive as a seed (a "structural_neighbor" of the top hit)
      // and the svc->file edge would never be offered to traversal at all,
      // since both endpoints would already be pre-visited.
      retrieveOptions: { expansionSeedCount: 0 },
      traverseOptions: { budget: { maxDepth: 2, maxNodes: 10, maxEdges: 10, maxReasoningSteps: 3, maxTokens: 8000 } },
    });

    expect(seeds.some((s) => s.nodeId === svcId)).toBe(true);
    expect(traversal.nodeIds).toContain(fileId);

    expect(context.subsystems).toContainEqual({ nodeId: svcId, name: "PaymentService", summary: undefined });
    expect(context.sourceFiles).toContainEqual({
      nodeId: fileId,
      path: "/src/storageAdapter.ts",
      summary: undefined,
    });
    expect(context.relationships.some((r) => r.from.id === svcId && r.to.id === fileId)).toBe(true);
  });

  it("surfaces an experience recorded for a node the traversal reaches (first real, non-test-scaffolding exercise of episodic's read path)", async () => {
    const repoId = `pipeline-test-${randomUUID()}`;
    const svcId = `${repoId}-checkout-service`;
    const helperId = `${repoId}-checkout-helper`;

    await upsertNode(makeNode(svcId, { type: "subsystem", name: "CheckoutService" }), repoId);
    await upsertNode(makeNode(helperId, { type: "function", name: "computeTotal" }), repoId);
    await upsertEdgeByTriple(makeEdge(svcId, helperId, { relation: "calls", weight: 0.9 }));

    const recorded = await recordExperience({
      task: "fix a rounding bug in checkout",
      observation: "totals were off by a cent for some carts",
      lessons: ["round after summing, not per line item"],
      relatedNodes: [helperId],
      confidence: 0.7,
    });

    const { context, traversal } = await runPipeline("CheckoutService", {
      repoId,
      graph: createPostgresGraphProvider(),
      reasoner: expandAllReasoner(),
      traverseOptions: { budget: { maxDepth: 2, maxNodes: 10, maxEdges: 10, maxReasoningSteps: 3, maxTokens: 8000 } },
    });

    expect(traversal.nodeIds).toContain(helperId);
    expect(context.experiences.some((e) => e.experienceId === recorded.id)).toBe(true);
  });

  it("calls a real embedder's embed() exactly once per invocation, even though it feeds both retrieval's vector leg and traversal's ranking", async () => {
    const repoId = `pipeline-test-${randomUUID()}`;
    const svcId = `${repoId}-billing-service`;
    const neighborId = `${repoId}-billing-neighbor`;

    await upsertNode(makeNode(svcId, { type: "subsystem", name: "BillingService" }), repoId);
    await upsertNode(makeNode(neighborId, { type: "function", name: "applyDiscount" }), repoId);
    await upsertEdgeByTriple(makeEdge(svcId, neighborId, { relation: "calls", weight: 0.8 }));

    const fake = createFakeEmbedder();
    const embed = vi.fn((text: string) => fake.embed(text));

    await runPipeline("BillingService", {
      repoId,
      embedder: { embed },
      graph: createPostgresGraphProvider(),
      reasoner: expandAllReasoner(),
    });

    expect(embed).toHaveBeenCalledTimes(1);
  });
});
