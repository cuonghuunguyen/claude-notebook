import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closePool,
  getEdgeByTriple,
  getNodeById,
  getPool,
  markNodeDeleted,
  queryExperiencesByNode,
  recordExperience,
  runMigrations,
  upsertEdgeByTriple,
  upsertNode,
} from "@cognitive-memory/graph-store";
import { runGC } from "./run.js";

// Same DATABASE_URL-gating convention as every other integration suite in
// this repo — skipped, not failed, without a real Postgres.
const hasDb = Boolean(process.env["DATABASE_URL"]);
const d = hasDb ? describe : describe.skip;

const DAY_MS = 24 * 60 * 60 * 1000;

async function backdateNode(id: string, when: Date): Promise<void> {
  await getPool().query(`UPDATE nodes SET updated_at = $1 WHERE id = $2`, [when, id]);
}

async function backdateEdge(id: string, when: Date): Promise<void> {
  await getPool().query(`UPDATE edges SET updated_at = $1 WHERE id = $2`, [when, id]);
}

async function makeActiveNode(): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await upsertNode(
    { id, type: "function", metadata: {}, provenance: [], status: "active", createdAt: now, updatedAt: now },
    `gc-test-${randomUUID()}`
  );
  return id;
}

d("packages/gc integration (spec.md §18 retention windows)", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await closePool();
  });

  it("hard-deletes deleted nodes older than 90 days, keeps ones inside the window", async () => {
    const now = new Date();
    const old = await makeActiveNode();
    const recent = await makeActiveNode();

    await markNodeDeleted(old);
    await markNodeDeleted(recent);
    await backdateNode(old, new Date(now.getTime() - 91 * DAY_MS));
    await backdateNode(recent, new Date(now.getTime() - 10 * DAY_MS));

    await runGC(now);

    expect(await getNodeById(old)).toBeUndefined();
    const stillThere = await getNodeById(recent);
    expect(stillThere?.status).toBe("deleted");
  });

  it("hard-deletes invalid edges older than 30 days, keeps ones inside the window", async () => {
    const now = new Date();
    const a = await makeActiveNode();
    const b = await makeActiveNode();
    const c = await makeActiveNode();
    const e = await makeActiveNode();

    const oldEdge = await upsertEdgeByTriple({
      id: randomUUID(),
      from: a,
      to: b,
      relation: "depends_on",
      confidence: 0.5,
      weight: 0.5,
      provenance: [],
      status: "invalid",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    const recentEdge = await upsertEdgeByTriple({
      id: randomUUID(),
      from: c,
      to: e,
      relation: "depends_on",
      confidence: 0.5,
      weight: 0.5,
      provenance: [],
      status: "invalid",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    await backdateEdge(oldEdge.id, new Date(now.getTime() - 31 * DAY_MS));
    await backdateEdge(recentEdge.id, new Date(now.getTime() - 10 * DAY_MS));

    await runGC(now);

    expect(await getEdgeByTriple(a, b, "depends_on")).toBeUndefined();
    expect((await getEdgeByTriple(c, e, "depends_on"))?.status).toBe("invalid");
  });

  it("marks an experience cold once every related node has a verified (durable-proxy) edge, leaves partially-promoted ones warm", async () => {
    const now = new Date();
    const promotedNode = await makeActiveNode();
    const otherPromotedNode = await makeActiveNode();
    const unpromotedNode = await makeActiveNode();

    await upsertEdgeByTriple({
      id: randomUUID(),
      from: promotedNode,
      to: otherPromotedNode,
      relation: "depends_on",
      confidence: 0.9,
      weight: 0.5,
      provenance: [],
      status: "active",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      lastVerifiedAt: now.toISOString(),
    });

    const fullyPromoted = await recordExperience({
      id: randomUUID(),
      task: "gc-test-fully-promoted",
      observation: "obs",
      relatedNodes: [promotedNode, otherPromotedNode],
      confidence: 0.7,
      timestamp: now.toISOString(),
    });
    const partiallyPromoted = await recordExperience({
      id: randomUUID(),
      task: "gc-test-partially-promoted",
      observation: "obs",
      relatedNodes: [promotedNode, unpromotedNode],
      confidence: 0.7,
      timestamp: now.toISOString(),
    });

    const result = await runGC(now);

    expect(result.experiencesMarkedCold).toBeGreaterThanOrEqual(1);
    const byPromotedNode = await queryExperiencesByNode(promotedNode, { includeCold: true });
    const promotedIds = byPromotedNode.map((e) => e.id);
    expect(promotedIds).toContain(fullyPromoted.id);
    expect(promotedIds).toContain(partiallyPromoted.id);

    // Default (cold excluded) query surfaces only the still-warm one.
    const warmOnly = await queryExperiencesByNode(promotedNode);
    const warmIds = warmOnly.map((e) => e.id);
    expect(warmIds).not.toContain(fullyPromoted.id);
    expect(warmIds).toContain(partiallyPromoted.id);
  });
});
