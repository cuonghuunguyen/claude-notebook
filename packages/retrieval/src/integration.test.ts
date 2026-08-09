import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Edge, Node } from "@cognitive-memory/core";
import {
  closePool,
  runMigrations,
  upsertEdgeByTriple,
  upsertNode,
} from "@cognitive-memory/graph-store";
import { createFakeEmbedder } from "./fakeEmbedder.js";
import { indexNodeEmbeddings } from "./indexing.js";
import { retrieveSeeds } from "./retrieve.js";

// Same DATABASE_URL-gating convention as packages/graph-store and
// packages/structural — skipped, not failed, without a real Postgres.
const hasDb = Boolean(process.env["DATABASE_URL"]);
const d = hasDb ? describe : describe.skip;

function makeNode(id: string, overrides: Partial<Node>): Node {
  const now = new Date().toISOString();
  return {
    id,
    type: "function",
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

d("retrieval integration", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await closePool();
  });

  it("finds a node via the lexical leg on a trigram-similar query", async () => {
    const repoId = `retrieval-test-${randomUUID()}`;
    const id = `${repoId}-payment-service`;
    await upsertNode(makeNode(id, { type: "class", name: "PaymentService" }), repoId);

    const seeds = await retrieveSeeds("PaymentService", { repoId });
    expect(seeds.some((s) => s.nodeId === id && s.reason === "lexical_match")).toBe(true);
  });

  it("finds a node via the vector leg once it's embedded, even with no lexical overlap", async () => {
    const repoId = `retrieval-test-${randomUUID()}`;
    const id = `${repoId}-surcharge`;
    const node = makeNode(id, {
      type: "function",
      name: "computeSurcharge",
      summary: "Adds a flat handling fee to a payment total.",
      metadata: { keywords: ["fee"] },
    });
    await upsertNode(node, repoId);
    const embedder = createFakeEmbedder();
    await indexNodeEmbeddings([node], embedder);

    // Query text shares no trigrams with "computeSurcharge" itself (so the
    // lexical leg can't find it) but overlaps on "fee"/"handling"/"total"
    // tokens from the node's summary/keywords, which only the vector leg sees.
    const seeds = await retrieveSeeds("flat handling fee total", { embedder, repoId });
    expect(seeds.some((s) => s.nodeId === id && s.reason === "semantic_match")).toBe(true);
  });

  it("expands a top hit to its 1-hop structural neighbors", async () => {
    const repoId = `retrieval-test-${randomUUID()}`;
    const classId = `${repoId}-payment-service`;
    const methodId = `${repoId}-charge-method`;
    await upsertNode(makeNode(classId, { type: "class", name: "PaymentServiceExpand" }), repoId);
    await upsertNode(makeNode(methodId, { type: "method", name: "charge" }), repoId);
    await upsertEdgeByTriple(
      makeEdge(classId, methodId, { relation: "contains", weight: 0.8 })
    );

    const seeds = await retrieveSeeds("PaymentServiceExpand", { repoId });
    expect(seeds.some((s) => s.nodeId === classId && s.reason === "lexical_match")).toBe(true);
    expect(seeds.some((s) => s.nodeId === methodId && s.reason === "structural_neighbor")).toBe(
      true
    );
  });

  it("re-sorts by score after expansion — a high-weight neighbor outranks a weak direct hit", async () => {
    const repoId = `retrieval-test-${randomUUID()}`;
    const weakHitId = `${repoId}-weak-hit`;
    const strongNeighborId = `${repoId}-strong-neighbor`;
    // A name that only weakly trigram-matches the query, so its lexical
    // score sits just above the default 0.1 threshold.
    await upsertNode(makeNode(weakHitId, { type: "class", name: "Xyzzzzzzzzzzzzz" }), repoId);
    await upsertNode(makeNode(strongNeighborId, { type: "method", name: "unrelatedMethodName" }), repoId);
    await upsertEdgeByTriple(
      makeEdge(weakHitId, strongNeighborId, { relation: "contains", weight: 0.95 })
    );

    const seeds = await retrieveSeeds("xyzz", { repoId, lexicalThreshold: 0.05 });
    const weakIndex = seeds.findIndex((s) => s.nodeId === weakHitId);
    const neighborIndex = seeds.findIndex((s) => s.nodeId === strongNeighborId);
    expect(weakIndex).toBeGreaterThanOrEqual(0);
    expect(neighborIndex).toBeGreaterThanOrEqual(0);
    expect(seeds[neighborIndex]?.score).toBeGreaterThan(seeds[weakIndex]?.score ?? Infinity);
    expect(neighborIndex).toBeLessThan(weakIndex); // higher score must sort first
  });

  it("expands a matched invariant to its highest-weight semantic neighbors", async () => {
    const repoId = `retrieval-test-${randomUUID()}`;
    const invariantId = `${repoId}-invariant`;
    const serviceId = `${repoId}-service`;
    await upsertNode(
      makeNode(invariantId, {
        type: "invariant",
        name: "PaymentEventOrderingInvariant",
        summary: "Payment events must be published after the database commit.",
      }),
      repoId
    );
    await upsertNode(makeNode(serviceId, { type: "class", name: "UnrelatedServiceName" }), repoId);
    await upsertEdgeByTriple(
      makeEdge(serviceId, invariantId, { relation: "constrained_by", weight: 0.9 })
    );

    const seeds = await retrieveSeeds("PaymentEventOrderingInvariant", { repoId });
    expect(seeds.some((s) => s.nodeId === invariantId)).toBe(true);
    expect(seeds.some((s) => s.nodeId === serviceId && s.reason === "semantic_neighbor")).toBe(
      true
    );
  });
});
