import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nodeId } from "@cognitive-memory/core";
import { closePool, getPool } from "./db.js";
import { runMigrations } from "./migrate.js";
import { getNodeById, markNodeDeleted, upsertNode } from "./nodes.js";
import { getEdgesTouchingNode, markEdgesStaleForNode, upsertEdgeByTriple } from "./edges.js";
import { queryExperiencesByNode, recordExperience } from "./experiences.js";
import { appendEvent, listEventsSince } from "./events.js";

// Integration tests only run against a real Postgres — set DATABASE_URL to
// enable them locally / in CI. They're skipped (not failed) otherwise, per
// ROADMAP.md M0/M1 acceptance criteria.
const hasDb = Boolean(process.env["DATABASE_URL"]);
const d = hasDb ? describe : describe.skip;

d("graph-store integration", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await closePool();
  });

  it("migrations are idempotent", async () => {
    const first = await runMigrations();
    expect(first.applied).toEqual([]); // already applied in beforeAll
  });

  it("round-trips a node through upsert/get, and rename updates in place", async () => {
    const repoId = `test-repo-${randomUUID()}`;
    const id = nodeId(repoId, "src/foo.ts#FooService");
    const now = new Date().toISOString();

    await upsertNode({
      id,
      type: "class",
      name: "FooService",
      path: "src/foo.ts",
      metadata: {},
      provenance: [
        {
          sourceType: "source_code",
          sourceId: "src/foo.ts",
          confidence: 1,
          observedAt: now,
        },
      ],
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    const fetched = await getNodeById(id);
    expect(fetched?.name).toBe("FooService");

    // Simulate a resolved rename: same id (spec.md §3.2), new path/name.
    await upsertNode({
      id,
      type: "class",
      name: "FooServiceRenamed",
      path: "src/foo-renamed.ts",
      metadata: {},
      provenance: fetched!.provenance,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    const renamed = await getNodeById(id);
    expect(renamed?.id).toBe(id); // identity preserved
    expect(renamed?.name).toBe("FooServiceRenamed");
  });

  it("marking a node deleted cascades staleness to its edges, not deletion", async () => {
    const repoId = `test-repo-${randomUUID()}`;
    const fromId = nodeId(repoId, "src/foo.ts#FooService");
    const toId = nodeId(repoId, "src/bar.ts#BarService");
    const now = new Date().toISOString();

    for (const [id, name] of [
      [fromId, "FooService"],
      [toId, "BarService"],
    ] as const) {
      await upsertNode({
        id,
        type: "class",
        name,
        metadata: {},
        provenance: [],
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
    }

    await upsertEdgeByTriple({
      id: randomUUID(),
      from: fromId,
      to: toId,
      relation: "calls",
      confidence: 1,
      weight: 0.5,
      provenance: [
        { sourceType: "source_code", sourceId: "src/foo.ts", confidence: 1, observedAt: now },
      ],
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    await markNodeDeleted(fromId);
    const staleCount = await markEdgesStaleForNode(fromId);
    expect(staleCount).toBe(1);

    const edges = await getEdgesTouchingNode(fromId);
    expect(edges).toHaveLength(1); // edge retained, not dropped — spec.md §3.2
    expect(edges[0]?.status).toBe("stale");
  });

  it("upserting the same (from, to, relation) triple appends provenance instead of duplicating", async () => {
    const repoId = `test-repo-${randomUUID()}`;
    const fromId = nodeId(repoId, "src/a.ts#A");
    const toId = nodeId(repoId, "src/b.ts#B");
    const now = new Date().toISOString();

    for (const id of [fromId, toId]) {
      await upsertNode({
        id,
        type: "class",
        metadata: {},
        provenance: [],
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
    }

    const edgeId = randomUUID();
    await upsertEdgeByTriple({
      id: edgeId,
      from: fromId,
      to: toId,
      relation: "depends_on",
      confidence: 0.6,
      weight: 0.5,
      provenance: [
        { sourceType: "llm_inference", sourceId: "pass-1", confidence: 0.6, observedAt: now },
      ],
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    await upsertEdgeByTriple({
      id: edgeId,
      from: fromId,
      to: toId,
      relation: "depends_on",
      confidence: 0.75,
      weight: 0.5,
      provenance: [
        { sourceType: "llm_inference", sourceId: "pass-1", confidence: 0.6, observedAt: now },
        { sourceType: "git_commit", sourceId: "abc123", confidence: 0.7, observedAt: now },
      ],
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    const edges = await getEdgesTouchingNode(fromId);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.provenance).toHaveLength(2);
    expect(edges[0]?.confidence).toBeCloseTo(0.75);
  });

  it("records an append-only experience and queries it back by related node", async () => {
    const nodeIdRef = randomUUID();
    const experienceId = randomUUID();

    await recordExperience({
      id: experienceId,
      task: "Fix duplicate payment events",
      observation: "Events were emitted before transaction completion.",
      action: "Moved event publication behind the transaction boundary.",
      result: "Duplicate events disappeared.",
      lessons: ["Payment events must not be emitted before transaction commit."],
      relatedNodes: [nodeIdRef],
      confidence: 0.8,
      timestamp: new Date().toISOString(),
    });

    const found = await queryExperiencesByNode(nodeIdRef);
    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe(experienceId);
  });

  it("appends events and lists them since a given id", async () => {
    const before = await appendEvent({ eventType: "CodeChanged", payload: { file: "a.ts" } });
    await appendEvent({ eventType: "SymbolAdded", payload: { id: "x" } });

    const since = await listEventsSince(before.id!);
    expect(since.length).toBeGreaterThanOrEqual(1);
    expect(since.every((e) => e.id! > before.id!)).toBe(true);
  });

  it("smoke-checks the pool is reachable", async () => {
    const pool = getPool();
    const { rows } = await pool.query("SELECT 1 as one");
    expect(rows[0]?.one).toBe(1);
  });
});
