import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nodeId } from "@cognitive-memory/core";
import { closePool, getEdgeByTriple, runMigrations, upsertNode } from "@cognitive-memory/graph-store";
import { recordObservation } from "@cognitive-memory/semantic";
import * as episodic from "./index.js";
import { queryByNode, queryByTask, recordExperience } from "./index.js";

describe("packages/episodic public API", () => {
  it("exposes no update or delete surface — spec.md §8 append-only is a package-boundary guarantee", () => {
    const exported = Object.keys(episodic);
    expect(exported).toContain("recordExperience");
    expect(exported).toContain("queryByNode");
    expect(exported).toContain("queryByTask");
    expect(exported.some((name) => /update|delete/i.test(name))).toBe(false);
  });
});

// Same DATABASE_URL-gating convention as every other integration suite in
// this repo — skipped, not failed, without a real Postgres.
const hasDb = Boolean(process.env["DATABASE_URL"]);
const d = hasDb ? describe : describe.skip;

d("packages/episodic integration", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await closePool();
  });

  it("round-trips a recorded experience through queryByNode and queryByTask", async () => {
    const task = `episodic-test-${randomUUID()}`;
    const nodeA = `node-${randomUUID()}`;
    const nodeB = `node-${randomUUID()}`;

    const recorded = await recordExperience({
      task,
      observation: "PaymentService.charge() threw on a null customerId",
      hypothesis: "charge() assumes customerId is always populated",
      action: "added a null-check and a regression test",
      result: "fixed; test now covers the null-customerId path",
      lessons: ["charge() must validate customerId before use"],
      relatedNodes: [nodeA, nodeB],
      confidence: 0.6,
    });

    expect(recorded.id).toBeTruthy();
    expect(recorded.timestamp).toBeTruthy();

    const byNode = await queryByNode(nodeA);
    expect(byNode.map((e) => e.id)).toContain(recorded.id);

    const byTask = await queryByTask(task);
    expect(byTask).toHaveLength(1);
    expect(byTask[0]).toEqual(recorded);
  });

  it("a repeatable lesson from a recorded experience feeds M3's promotion pipeline and reaches candidate", async () => {
    const repoId = `episodic-test-${randomUUID()}`;
    const fromId = nodeId(repoId, "src/paymentService.ts#PaymentService.charge");
    const toId = nodeId(repoId, "invariant:customerId-required");
    const now = new Date().toISOString();

    for (const id of [fromId, toId]) {
      await upsertNode(
        { id, type: "invariant", metadata: {}, provenance: [], status: "active", createdAt: now, updatedAt: now },
        repoId
      );
    }

    // A structural pass already recorded this constraint from source code.
    const first = await recordObservation(fromId, toId, "constrained_by", {
      sourceType: "source_code",
      sourceId: "src/paymentService.ts",
      confidence: 0.8,
      observedAt: now,
    });
    expect(first.promotion.stage).toBe("observation");

    // An agent independently hits the same constraint on a real task and
    // records what it learned — spec.md §8: an experience is just another
    // sourceType: "agent_experience" provenance record feeding §7's pipeline.
    const experience = await recordExperience({
      task: "fix-null-customerId-crash",
      observation: "charge() crashed when customerId was null",
      lessons: ["PaymentService.charge() requires a non-null customerId"],
      relatedNodes: [fromId, toId],
      confidence: 0.7,
    });

    const second = await recordObservation(fromId, toId, "constrained_by", {
      sourceType: "agent_experience",
      sourceId: experience.id,
      evidence: experience.lessons?.[0],
      confidence: experience.confidence,
      observedAt: experience.timestamp,
    });

    // Same table as packages/semantic's own tests: 2 observations from 2
    // distinct sourceTypes reach candidate, capped at 0.75.
    expect(second.promotion.stage).toBe("candidate");
    expect(second.promotion.confidence).toBeLessThanOrEqual(0.75);
    expect(second.edge.provenance).toHaveLength(2);

    const persisted = await getEdgeByTriple(fromId, toId, "constrained_by");
    expect(
      persisted?.provenance.some(
        (p) => p.sourceType === "agent_experience" && p.sourceId === experience.id
      )
    ).toBe(true);
  });
});
