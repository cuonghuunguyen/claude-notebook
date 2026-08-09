import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Edge } from "@cognitive-memory/core";
import {
  closePool,
  getEdgeByTriple,
  listEventsSince,
  markNodeDeleted,
  runMigrations,
  upsertEdgeByTriple,
  upsertNode,
} from "@cognitive-memory/graph-store";
import { createStructuralVerifier, resolveStaleFrontierEdges, verifyStaleEdge } from "./index.js";
import type { StructuralVerifier } from "./types.js";

// Same DATABASE_URL-gating convention as every other integration suite in
// this repo — skipped, not failed, without a real Postgres.
const hasDb = Boolean(process.env["DATABASE_URL"]);
const d = hasDb ? describe : describe.skip;

async function makeActiveNode(): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await upsertNode(
    { id, type: "function", metadata: {}, provenance: [], status: "active", createdAt: now, updatedAt: now },
    `staleness-test-${randomUUID()}`
  );
  return id;
}

function staleEdge(from: string, to: string): Edge {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    from,
    to,
    relation: "depends_on",
    confidence: 0.7,
    weight: 0.5,
    provenance: [{ sourceType: "llm_inference", sourceId: "test", confidence: 0.7, observedAt: now }],
    status: "stale",
    createdAt: now,
    updatedAt: now,
  };
}

d("packages/staleness integration (spec.md §12)", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await closePool();
  });

  it("both endpoints still active -> valid -> refreshes to active with lastVerifiedAt set", async () => {
    const a = await makeActiveNode();
    const b = await makeActiveNode();
    const edge = await upsertEdgeByTriple(staleEdge(a, b));

    const verified = await verifyStaleEdge(edge, createStructuralVerifier());

    expect(verified.status).toBe("active");
    expect(verified.lastVerifiedAt).toBeTruthy();
    const persisted = await getEdgeByTriple(a, b, "depends_on");
    expect(persisted?.status).toBe("active");
  });

  it("an endpoint no longer active -> invalid -> invalidates and appends RelationInvalidated", async () => {
    const a = await makeActiveNode();
    const b = await makeActiveNode();
    await markNodeDeleted(b);
    const edge = await upsertEdgeByTriple(staleEdge(a, b));

    const beforeEvents = await listEventsSince(0);
    const verified = await verifyStaleEdge(edge, createStructuralVerifier());

    expect(verified.status).toBe("invalid");
    const persisted = await getEdgeByTriple(a, b, "depends_on");
    expect(persisted?.status).toBe("invalid");

    const afterEvents = await listEventsSince(beforeEvents[beforeEvents.length - 1]?.id ?? 0);
    expect(
      afterEvents.some(
        (e) => e.eventType === "RelationInvalidated" && (e.payload as { edgeId: string }).edgeId === edge.id
      )
    ).toBe(true);
  });

  it("resolveStaleFrontierEdges passes active edges through, refreshes valid stale ones, drops invalid ones", async () => {
    const a = await makeActiveNode();
    const b = await makeActiveNode();
    const c = await makeActiveNode();
    const d1 = await makeActiveNode();

    const activeEdge = await upsertEdgeByTriple({ ...staleEdge(a, b), status: "active" });
    const validStale = await upsertEdgeByTriple(staleEdge(b, c));
    await markNodeDeleted(d1);
    const invalidStale = await upsertEdgeByTriple(staleEdge(c, d1));

    const resolved = await resolveStaleFrontierEdges(
      [activeEdge, validStale, invalidStale],
      createStructuralVerifier()
    );

    const resolvedIds = resolved.map((e) => e.id);
    expect(resolvedIds).toContain(activeEdge.id);
    expect(resolvedIds).toContain(validStale.id);
    expect(resolvedIds).not.toContain(invalidStale.id);
    expect(resolved.find((e) => e.id === validStale.id)?.status).toBe("active");
  });

  it("verifier is a pluggable interface — a scripted fake drives the same refresh/invalidate behavior", async () => {
    const a = await makeActiveNode();
    const b = await makeActiveNode();
    const edge = await upsertEdgeByTriple(staleEdge(a, b));

    const alwaysInvalid: StructuralVerifier = { verify: async () => "invalid" };
    const verified = await verifyStaleEdge(edge, alwaysInvalid);

    expect(verified.status).toBe("invalid");
  });
});
