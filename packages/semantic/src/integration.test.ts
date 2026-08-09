import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nodeId } from "@cognitive-memory/core";
import {
  closePool,
  getEdgeByTriple,
  listEventsSince,
  runMigrations,
  upsertNode,
} from "@cognitive-memory/graph-store";
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

  it("verified:true on a lone observation does not set lastVerifiedAt or emit ExperiencePromoted — it's nowhere near durable (spec.md §14)", async () => {
    const repoId = `semantic-test-${randomUUID()}`;
    const fromId = nodeId(repoId, "src/lone.ts#Lone");
    const toId = nodeId(repoId, "concept:lone-target");
    const now = new Date().toISOString();

    for (const id of [fromId, toId]) {
      await upsertNode(
        { id, type: "concept", metadata: {}, provenance: [], status: "active", createdAt: now, updatedAt: now },
        repoId
      );
    }

    const eventsBefore = await listEventsSince(0);
    const { edge, promotion } = await recordObservation(
      fromId,
      toId,
      "owns",
      { sourceType: "source_code", sourceId: "src/lone.ts", confidence: 0.9, observedAt: now },
      { verified: true }
    );

    expect(promotion.stage).toBe("observation");
    expect(edge.lastVerifiedAt).toBeUndefined();

    const newEvents = await listEventsSince(eventsBefore[eventsBefore.length - 1]?.id ?? 0);
    expect(newEvents.some((e) => e.eventType === "ExperiencePromoted")).toBe(false);
  });

  it("ExperiencePromoted fires once on the transition into durable, not again on later writes to an already-durable triple", async () => {
    const repoId = `semantic-test-${randomUUID()}`;
    const fromId = nodeId(repoId, "src/repeat.ts#Repeat");
    const toId = nodeId(repoId, "concept:repeat-target");
    const now = new Date().toISOString();

    for (const id of [fromId, toId]) {
      await upsertNode(
        { id, type: "concept", metadata: {}, provenance: [], status: "active", createdAt: now, updatedAt: now },
        repoId
      );
    }

    await recordObservation(fromId, toId, "owns", {
      sourceType: "source_code",
      sourceId: "src/repeat.ts",
      confidence: 0.9,
      observedAt: now,
    });
    const eventsBeforeDurable = await listEventsSince(0);
    const durableWrite = await recordObservation(
      fromId,
      toId,
      "owns",
      { sourceType: "test", sourceId: "repeat.test.ts", confidence: 0.9, observedAt: now },
      { verified: true }
    );
    expect(durableWrite.promotion.stage).toBe("durable");
    const eventsAfterDurable = await listEventsSince(eventsBeforeDurable[eventsBeforeDurable.length - 1]?.id ?? 0);
    expect(eventsAfterDurable.filter((e) => e.eventType === "ExperiencePromoted")).toHaveLength(1);

    // A later write to the SAME already-durable triple that ALSO verifies
    // (computePromotion's durable gate is evaluated per-call from the
    // options passed that call, per spec.md §7 — it isn't a persisted
    // ratchet, so this second call must pass `verified: true` again to
    // land on "durable" a second time and actually exercise the
    // already-durable de-dup path).
    const eventsBeforeSecond = await listEventsSince(0);
    const secondWrite = await recordObservation(
      fromId,
      toId,
      "owns",
      { sourceType: "documentation", sourceId: "README", confidence: 0.9, observedAt: now },
      { verified: true }
    );
    expect(secondWrite.promotion.stage).toBe("durable");
    const eventsAfterSecond = await listEventsSince(eventsBeforeSecond[eventsBeforeSecond.length - 1]?.id ?? 0);
    expect(eventsAfterSecond.some((e) => e.eventType === "ExperiencePromoted")).toBe(false);
    expect(eventsAfterSecond.some((e) => e.eventType === "RelationAdded")).toBe(true);
  });
});
