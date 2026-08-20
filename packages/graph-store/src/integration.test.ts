import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nodeId } from "@cognitive-memory/core";
import { closePool, getPool } from "./db.js";
import { runMigrations } from "./migrate.js";
import {
  getNodeById,
  getNodesByPath,
  markNodeDeleted,
  searchNodesByTrigram,
  upsertNode,
} from "./nodes.js";
import {
  getEdgeByTriple,
  getEdgesTouchingNode,
  markEdgeInvalid,
  markEdgesStaleForNode,
  upsertEdgeByTriple,
} from "./edges.js";
import { queryExperiencesByNode, recordExperience, supersedeExperience } from "./experiences.js";
import { appendEvent, listEventsSince } from "./events.js";
import { replayEvents, wipeMaterializedGraph } from "./materializer.js";

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

    await upsertNode(
      {
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
      },
      repoId
    );

    const fetched = await getNodeById(id);
    expect(fetched?.name).toBe("FooService");

    // Simulate a resolved rename: same id (spec.md §3.2), new path/name.
    await upsertNode(
      {
        id,
        type: "class",
        name: "FooServiceRenamed",
        path: "src/foo-renamed.ts",
        metadata: {},
        provenance: fetched!.provenance,
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
      repoId
    );

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
      await upsertNode(
        {
          id,
          type: "class",
          name,
          metadata: {},
          provenance: [],
          status: "active",
          createdAt: now,
          updatedAt: now,
        },
        repoId
      );
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
      await upsertNode(
        {
          id,
          type: "class",
          metadata: {},
          provenance: [],
          status: "active",
          createdAt: now,
          updatedAt: now,
        },
        repoId
      );
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

  it("getNodesByPath is scoped by repoId — two repos sharing a relative path don't collide", async () => {
    const repoA = `test-repo-${randomUUID()}`;
    const repoB = `test-repo-${randomUUID()}`;
    const now = new Date().toISOString();
    const sharedPath = "src/foo.ts";

    await upsertNode(
      {
        id: nodeId(repoA, `${sharedPath}#A`),
        type: "class",
        name: "A",
        path: sharedPath,
        metadata: {},
        provenance: [],
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
      repoA
    );
    await upsertNode(
      {
        id: nodeId(repoB, `${sharedPath}#B`),
        type: "class",
        name: "B",
        path: sharedPath,
        metadata: {},
        provenance: [],
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
      repoB
    );

    const inRepoA = await getNodesByPath(repoA, sharedPath);
    expect(inRepoA).toHaveLength(1);
    expect(inRepoA[0]?.name).toBe("A");

    const inRepoB = await getNodesByPath(repoB, sharedPath);
    expect(inRepoB).toHaveLength(1);
    expect(inRepoB[0]?.name).toBe("B");
  });

  it("searchNodesByTrigram is scoped by repoId — a same-named node in another repo doesn't leak in", async () => {
    const repoA = `test-repo-${randomUUID()}`;
    const repoB = `test-repo-${randomUUID()}`;
    const now = new Date().toISOString();
    const sharedName = `UniqueSearchName${randomUUID().slice(0, 8)}`;

    await upsertNode(
      {
        id: nodeId(repoA, `${sharedName}#A`),
        type: "class",
        name: sharedName,
        metadata: {},
        provenance: [],
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
      repoA
    );
    await upsertNode(
      {
        id: nodeId(repoB, `${sharedName}#B`),
        type: "class",
        name: sharedName,
        metadata: {},
        provenance: [],
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
      repoB
    );

    const inRepoA = await searchNodesByTrigram(sharedName, 10, 0.1, repoA);
    expect(inRepoA).toHaveLength(1);
    expect(inRepoA[0]?.node.name).toBe(sharedName);

    const inRepoB = await searchNodesByTrigram(sharedName, 10, 0.1, repoB);
    expect(inRepoB).toHaveLength(1);
    expect(inRepoB[0]?.node.name).toBe(sharedName);

    const unscoped = await searchNodesByTrigram(sharedName, 10, 0.1);
    expect(unscoped.length).toBeGreaterThanOrEqual(2);
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
    const repoId = `event-test-${randomUUID()}`;
    const id = nodeId(repoId, "src/a.ts#A");
    const now = new Date().toISOString();
    const node = {
      id,
      type: "function" as const,
      metadata: {},
      provenance: [],
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    };

    const before = await appendEvent({ eventType: "CodeChanged", payload: { node, repoId } });
    await appendEvent({ eventType: "SymbolAdded", payload: { node, repoId } });

    const since = await listEventsSince(before.id!);
    expect(since.length).toBeGreaterThanOrEqual(1);
    expect(since.every((e) => e.id! > before.id!)).toBe(true);
  });

  it("smoke-checks the pool is reachable", async () => {
    const pool = getPool();
    const { rows } = await pool.query("SELECT 1 as one");
    expect(rows[0]?.one).toBe(1);
  });

  // Last in the file deliberately: wipeMaterializedGraph/rebuildFromEvents
  // TRUNCATEs nodes/edges/experiences for the whole database, not just this
  // test's own rows. Every `it` above already ran and asserted before this
  // one starts (vitest runs one file's `it`s in declaration order), so
  // wiping here doesn't retroactively break them. Safe with respect to
  // OTHER packages' test suites too: pnpm's topological script ordering
  // (verified empirically — see this PR's description) means no package
  // that depends on graph-store starts its own test script until this
  // entire file has finished, so nothing else is touching the shared
  // Postgres instance while this runs.
  it("rebuild-from-events: wiping the materialized graph and replaying the event log reproduces the same state (spec.md §14)", async () => {
    // Scoped to this test's OWN events (from this point forward), not
    // `rebuildFromEvents()`'s full `listEventsSince(0)` — the events table
    // is shared across every suite that has ever run against this
    // database, and this test only controls the well-formedness of its own
    // contribution to it, not every fixture any other package's tests have
    // ever written. `wipeMaterializedGraph` + a scoped `replayEvents` still
    // exercises the exact same wipe-then-replay mechanism
    // `rebuildFromEvents` uses internally.
    const replayFromId = (await listEventsSince(0)).at(-1)?.id ?? 0;

    const repoId = `rebuild-test-${randomUUID()}`;
    const now = new Date().toISOString();
    const fromId = nodeId(repoId, "src/a.ts#A");
    const toId = nodeId(repoId, "src/b.ts#B");

    const nodeA = {
      id: fromId,
      type: "function" as const,
      name: "a",
      path: "src/a.ts",
      metadata: { language: "typescript" },
      provenance: [{ sourceType: "source_code" as const, sourceId: "src/a.ts", confidence: 1, observedAt: now }],
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    };
    const nodeB = {
      id: toId,
      type: "function" as const,
      name: "b",
      path: "src/b.ts",
      metadata: { language: "typescript" },
      provenance: [{ sourceType: "source_code" as const, sourceId: "src/b.ts", confidence: 1, observedAt: now }],
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    };

    // SymbolAdded x2, then RelationAdded — mirrors packages/structural's
    // persist.ts ordering (nodes before edges).
    await upsertNode(nodeA, repoId);
    await appendEvent({ eventType: "SymbolAdded", payload: { node: nodeA, repoId } });
    await upsertNode(nodeB, repoId);
    await appendEvent({ eventType: "SymbolAdded", payload: { node: nodeB, repoId } });

    const edge = await upsertEdgeByTriple({
      id: randomUUID(),
      from: fromId,
      to: toId,
      relation: "calls",
      confidence: 1,
      weight: 0.5,
      provenance: [{ sourceType: "source_code" as const, sourceId: "src/a.ts", confidence: 1, observedAt: now }],
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await appendEvent({ eventType: "RelationAdded", payload: { edge } });

    // A content change to A (e.g. a rename) — CodeChanged, plus the
    // dependent-edge staleness side effect it carries (spec.md §12).
    const nodeARenamed = { ...nodeA, name: "aRenamed" };
    await upsertNode(nodeARenamed, repoId);
    await appendEvent({ eventType: "CodeChanged", payload: { node: nodeARenamed, repoId } });
    await markEdgesStaleForNode(fromId);

    // Lazy verification's invalidate outcome (spec.md §12) on that now-stale edge.
    await markEdgeInvalid(edge.id);
    await appendEvent({
      eventType: "RelationInvalidated",
      payload: { edgeId: edge.id, from: fromId, to: toId, relation: edge.relation },
    });

    // One episodic experience.
    const experience = await recordExperience({
      id: randomUUID(),
      task: `rebuild-test-${randomUUID()}`,
      observation: "A calls B and B's behavior changed",
      relatedNodes: [fromId, toId],
      confidence: 0.6,
      timestamp: now,
    });
    await appendEvent({ eventType: "ExperienceRecorded", payload: { experience } });

    // A correction that retracts it (spec.md §24.6 / M13). This is the case
    // that forced `ExperienceSuperseded` into §14's event vocabulary: a replay
    // that could not reconstruct the link would put a memory the system has
    // WITHDRAWN back into the default retrieval path — the rebuilt graph would
    // answer with retracted knowledge, not merely lose metadata.
    const correction = await recordExperience({
      id: randomUUID(),
      task: experience.task,
      observation: "Correction: B's behavior changed back",
      relatedNodes: [fromId, toId],
      confidence: 0.8,
      timestamp: now,
    });
    await appendEvent({ eventType: "ExperienceRecorded", payload: { experience: correction } });
    const link = await supersedeExperience(experience.id, correction.id);
    await appendEvent({
      eventType: "ExperienceSuperseded",
      payload: {
        oldId: experience.id,
        newId: correction.id,
        supersededAt: link.supersededAt,
      },
    });

    // Omit fields the materializer can't reproduce byte-for-byte on
    // replay: createdAt/updatedAt are server-generated via `now()` on
    // every write (see nodes.ts/edges.ts — never taken from the caller's
    // object), so a replayed write inevitably gets a fresh timestamp.
    // What matters for "the graph is a genuine projection over events" is
    // that every OTHER field — identity, content, status — matches.
    function normalizeNode(n: Awaited<ReturnType<typeof getNodeById>>) {
      return n && { ...n, createdAt: undefined, updatedAt: undefined };
    }
    function normalizeEdge(e: Awaited<ReturnType<typeof getEdgeByTriple>>) {
      return e && { ...e, createdAt: undefined, updatedAt: undefined, lastVerifiedAt: undefined };
    }

    const preNodeA = normalizeNode(await getNodeById(fromId));
    const preNodeB = normalizeNode(await getNodeById(toId));
    const preEdge = normalizeEdge(await getEdgeByTriple(fromId, toId, "calls"));
    const preExperiences = (
      await queryExperiencesByNode(fromId, { includeCold: true, includeSuperseded: true })
    ).map((e) => ({ ...e, timestamp: undefined, supersededAt: undefined }));
    const preHeads = (await queryExperiencesByNode(fromId, { includeCold: true })).map((e) => e.id);

    await wipeMaterializedGraph();
    await replayEvents(await listEventsSince(replayFromId));

    const postNodeA = normalizeNode(await getNodeById(fromId));
    const postNodeB = normalizeNode(await getNodeById(toId));
    const postEdge = normalizeEdge(await getEdgeByTriple(fromId, toId, "calls"));
    const postExperiences = (
      await queryExperiencesByNode(fromId, { includeCold: true, includeSuperseded: true })
    ).map((e) => ({ ...e, timestamp: undefined, supersededAt: undefined }));
    const postHeads = (await queryExperiencesByNode(fromId, { includeCold: true })).map((e) => e.id);

    expect(postNodeA).toEqual(preNodeA);
    expect(postNodeA?.name).toBe("aRenamed"); // the CodeChanged replay actually applied, not just the original SymbolAdded
    expect(postNodeB).toEqual(preNodeB);
    expect(postEdge).toEqual(preEdge);
    expect(postEdge?.status).toBe("invalid"); // the RelationInvalidated replay actually applied
    expect(postExperiences).toEqual(preExperiences);
    // The supersede link came back with them: the retracted memory is still
    // out of the default path after the rebuild, not resurrected by it.
    expect(postHeads).toEqual(preHeads);
    expect(postHeads).toContain(correction.id);
    expect(postHeads).not.toContain(experience.id);
  });
});
