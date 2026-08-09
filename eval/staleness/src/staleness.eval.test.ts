import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closePool,
  getEdgeByTriple,
  getNodeById,
  listEventsSince,
  runMigrations,
} from "@cognitive-memory/graph-store";
import { extractChangedFiles } from "@cognitive-memory/structural";
import { createStructuralVerifier, verifyStaleEdge } from "@cognitive-memory/staleness";
import { buildStalenessFixture, FIXTURE_PATH, type StalenessFixture } from "./fixture.js";

// Same DATABASE_URL-gating convention as every other integration/eval suite
// in this repo — skipped, not failed, without a real Postgres.
const hasDb = Boolean(process.env["DATABASE_URL"]);
const d = hasDb ? describe : describe.skip;

d("staleness eval set (spec.md §19 point 2 / §12 / ROADMAP.md M7)", () => {
  afterAll(async () => {
    await closePool();
  });

  beforeAll(async () => {
    await runMigrations();
  });

  it("a plain rename flips the renamed function's semantic edge stale, appends CodeChanged, and leaves the untouched function's edge active", async () => {
    const fixture: StalenessFixture = await buildStalenessFixture();
    const eventsBefore = await listEventsSince(0);

    // Inject the refactor: rename `helper` in place (same file, same body —
    // spec.md §3.2 keeps its node id, so this is NOT a delete+create).
    const sourceFile = fixture.project.getSourceFileOrThrow(FIXTURE_PATH);
    sourceFile.getFunctionOrThrow("helper").rename("helperRenamed");

    await extractChangedFiles(fixture.project, [FIXTURE_PATH], fixture.repoId);

    const helperNode = await getNodeById(fixture.helperId);
    expect(helperNode?.id).toBe(fixture.helperId); // identity survives the rename
    expect(helperNode?.name).toBe("helperRenamed");

    const helperEdge = await getEdgeByTriple(fixture.helperId, fixture.helperInvariantId, "constrained_by");
    expect(helperEdge?.status).toBe("stale");

    // The untouched function's edge must NOT flip — it shares a file with
    // `helper` but its own content never changed.
    const untouchedEdge = await getEdgeByTriple(
      fixture.untouchedId,
      fixture.untouchedInvariantId,
      "constrained_by"
    );
    expect(untouchedEdge?.status).toBe("active");

    const newEvents = await listEventsSince(eventsBefore[eventsBefore.length - 1]?.id ?? 0);
    expect(
      newEvents.some(
        (e) => e.eventType === "CodeChanged" && (e.payload as { node: { id: string } }).node.id === fixture.helperId
      )
    ).toBe(true);

    // Lazy verification (spec.md §12): the renamed function still exists
    // (just under a new name) and so does the invariant it's constrained
    // by — both endpoints live, so this stale edge should verify valid and
    // refresh back to active.
    const refreshed = await verifyStaleEdge(helperEdge!, createStructuralVerifier());
    expect(refreshed.status).toBe("active");
    expect(refreshed.lastVerifiedAt).toBeTruthy();
  });

  it("deleting a function flips its semantic edge stale, appends SymbolRemoved, and lazy verification invalidates the now-dead edge", async () => {
    const fixture: StalenessFixture = await buildStalenessFixture();
    const eventsBefore = await listEventsSince(0);

    // Inject the refactor: delete `untouched` outright.
    const sourceFile = fixture.project.getSourceFileOrThrow(FIXTURE_PATH);
    sourceFile.getFunctionOrThrow("untouched").remove();

    const incremental = await extractChangedFiles(fixture.project, [FIXTURE_PATH], fixture.repoId);
    expect(incremental.deletedNodes).toContain(fixture.untouchedId);

    const untouchedNode = await getNodeById(fixture.untouchedId);
    expect(untouchedNode?.status).toBe("deleted");

    const untouchedEdge = await getEdgeByTriple(
      fixture.untouchedId,
      fixture.untouchedInvariantId,
      "constrained_by"
    );
    expect(untouchedEdge?.status).toBe("stale");

    // helper's edge is untouched by this refactor.
    const helperEdge = await getEdgeByTriple(fixture.helperId, fixture.helperInvariantId, "constrained_by");
    expect(helperEdge?.status).toBe("active");

    const newEvents = await listEventsSince(eventsBefore[eventsBefore.length - 1]?.id ?? 0);
    expect(
      newEvents.some(
        (e) => e.eventType === "SymbolRemoved" && (e.payload as { id: string }).id === fixture.untouchedId
      )
    ).toBe(true);

    // Lazy verification: `untouched` is gone, so this can never hold again.
    const verified = await verifyStaleEdge(untouchedEdge!, createStructuralVerifier());
    expect(verified.status).toBe("invalid");

    const eventsAfterVerify = await listEventsSince(newEvents[newEvents.length - 1]?.id ?? 0);
    expect(
      eventsAfterVerify.some(
        (e) => e.eventType === "RelationInvalidated" && (e.payload as { edgeId: string }).edgeId === untouchedEdge!.id
      )
    ).toBe(true);
  });
});
