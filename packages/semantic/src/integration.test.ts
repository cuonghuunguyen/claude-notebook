import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nodeId } from "@cognitive-memory/core";
import { closePool, getEdgeByTriple, runMigrations, upsertNode } from "@cognitive-memory/graph-store";
import { recordObservation } from "./edge.js";

// Same DATABASE_URL-gating convention as every other integration suite in
// this repo — skipped, not failed, without a real Postgres.
const hasDb = Boolean(process.env["DATABASE_URL"]);
const d = hasDb ? describe : describe.skip;

d("packages/semantic integration", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await closePool();
  });

  it("accumulates observations across calls into one edge's provenance, promoting stage as corroboration grows", async () => {
    const repoId = `semantic-test-${randomUUID()}`;
    const fromId = nodeId(repoId, "src/paymentService.ts#PaymentService");
    const toId = nodeId(repoId, "concept:transaction-boundary");
    const now = new Date().toISOString();

    for (const id of [fromId, toId]) {
      await upsertNode(
        { id, type: "concept", metadata: {}, provenance: [], status: "active", createdAt: now, updatedAt: now },
        repoId
      );
    }

    const first = await recordObservation(fromId, toId, "owns", {
      sourceType: "source_code",
      sourceId: "src/paymentService.ts",
      confidence: 0.9,
      observedAt: now,
    });
    expect(first.promotion.stage).toBe("observation");

    const second = await recordObservation(fromId, toId, "owns", {
      sourceType: "git_commit",
      sourceId: "abc123",
      confidence: 0.8,
      observedAt: now,
    });
    expect(second.promotion.stage).toBe("candidate");
    expect(second.promotion.confidence).toBeLessThanOrEqual(0.75);
    expect(second.edge.provenance).toHaveLength(2); // merged, not overwritten

    const third = await recordObservation(
      fromId,
      toId,
      "owns",
      { sourceType: "test", sourceId: "payment.test.ts", confidence: 0.95, observedAt: now },
      { verified: true }
    );
    expect(third.promotion.stage).toBe("durable");
    expect(third.edge.provenance).toHaveLength(3);
    expect(third.edge.lastVerifiedAt).toBeDefined();

    const persisted = await getEdgeByTriple(fromId, toId, "owns");
    expect(persisted?.provenance).toHaveLength(3);
    expect(persisted?.status).toBe("active");
  });

  it("a same-sourceType conflict persists the edge as disputed with both facts kept", async () => {
    const repoId = `semantic-test-${randomUUID()}`;
    const fromId = nodeId(repoId, "src/a.ts#A");
    const toId = nodeId(repoId, "src/b.ts#B");
    const now = new Date().toISOString();

    for (const id of [fromId, toId]) {
      await upsertNode(
        { id, type: "class", metadata: {}, provenance: [], status: "active", createdAt: now, updatedAt: now },
        repoId
      );
    }

    await recordObservation(fromId, toId, "depends_on", {
      sourceType: "source_code",
      sourceId: "pass-1",
      confidence: 0.9,
      observedAt: now,
    });
    const { edge, promotion } = await recordObservation(fromId, toId, "depends_on", {
      sourceType: "source_code",
      sourceId: "pass-2",
      confidence: 0.2,
      observedAt: now,
    });

    expect(promotion.status).toBe("disputed");
    expect(edge.status).toBe("disputed");
    expect(edge.provenance).toHaveLength(2); // both facts kept, not silently collapsed
  });

  it("concurrent observations on the same brand-new triple don't lose each other's provenance", async () => {
    const repoId = `semantic-test-${randomUUID()}`;
    const fromId = nodeId(repoId, "src/concurrent.ts#Concurrent");
    const toId = nodeId(repoId, "concept:concurrency-target");
    const now = new Date().toISOString();

    for (const id of [fromId, toId]) {
      await upsertNode(
        { id, type: "concept", metadata: {}, provenance: [], status: "active", createdAt: now, updatedAt: now },
        repoId
      );
    }

    const sourceTypes = [
      "source_code",
      "test",
      "documentation",
      "pull_request",
      "git_commit",
      "agent_experience",
      "llm_inference",
    ] as const;

    // All fire before any of them has a chance to complete — without the
    // advisory lock in recordObservation, this is exactly the interleaving
    // that silently drops provenance entries.
    await Promise.all(
      sourceTypes.map((sourceType, i) =>
        recordObservation(fromId, toId, "related_to", {
          sourceType,
          sourceId: `concurrent-${i}`,
          confidence: 0.7,
          observedAt: now,
        })
      )
    );

    const persisted = await getEdgeByTriple(fromId, toId, "related_to");
    expect(persisted?.provenance).toHaveLength(sourceTypes.length);
  });
});
