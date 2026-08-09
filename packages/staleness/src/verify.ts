import type { Edge } from "@cognitive-memory/core";
import {
  appendEvent,
  getNodeById,
  getPool,
  markEdgeInvalid,
  upsertEdgeByTriple,
} from "@cognitive-memory/graph-store";
import type { StructuralVerifier, VerificationOutcome } from "./types.js";

/**
 * Real `StructuralVerifier` (spec.md §12): an edge holds only if both
 * endpoints still exist as live (`active`) structural/semantic nodes.
 * Deliberately does NOT re-check the semantic *content* of the fact itself
 * (e.g. "does this function still actually throw on null input") — that
 * would need an LLM call, out of MVP scope here the same way traversal's
 * (M5) real reasoning call is injected rather than hardcoded. This is the
 * cheap, deterministic half of verification: an edge whose endpoint was
 * deleted or itself hard-invalidated can never hold regardless of content.
 */
export function createStructuralVerifier(): StructuralVerifier {
  return {
    async verify(edge: Edge): Promise<VerificationOutcome> {
      const [from, to] = await Promise.all([getNodeById(edge.from), getNodeById(edge.to)]);
      const endpointsLive = from?.status === "active" && to?.status === "active";
      return endpointsLive ? "valid" : "invalid";
    },
  };
}

/**
 * spec.md §12's lazy-verification pipeline for one stale edge:
 * `stale edge retrieved -> verify against current code -> valid: refresh |
 * invalid: invalidate`.
 *
 * "Refresh" is a pure status/`lastVerifiedAt` update — no event is
 * appended, because nothing about the fact itself changed (spec.md §14's
 * event vocabulary has no "still true, no change" event, and the
 * rebuild-from-events replay doesn't need one: a refresh is a
 * deterministic re-derivation from currently-live graph state, not new
 * history). "Invalidate" IS new history — `RelationInvalidated` is
 * appended, matching the materializer's handler for that event type.
 */
export async function verifyStaleEdge(edge: Edge, verifier: StructuralVerifier): Promise<Edge> {
  const outcome = await verifier.verify(edge);
  if (outcome === "invalid") {
    // Transactional: the status flip and its RelationInvalidated event must
    // land together, or a failure between them leaves an edge that's
    // actually invalid but has no event recording why (spec.md §14) — a gap
    // a later rebuild-from-events replay would silently reproduce as
    // "still stale" instead.
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const invalidated = await markEdgeInvalid(edge.id, client);
      await appendEvent(
        {
          eventType: "RelationInvalidated",
          payload: { edgeId: edge.id, from: edge.from, to: edge.to, relation: edge.relation },
        },
        client
      );
      await client.query("COMMIT");
      return invalidated ?? { ...edge, status: "invalid" };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  const now = new Date().toISOString();
  return upsertEdgeByTriple({ ...edge, status: "active", lastVerifiedAt: now, updatedAt: now });
}

/**
 * Batch entry point for a graph read path that just fetched a mix of
 * `active`/`stale` edges (e.g. traversal's frontier fetch, frontier.ts):
 * verifies every stale one, drops any that came back `invalid` (no longer a
 * usable graph fact), and passes `active` edges through untouched.
 *
 * Verifications run concurrently (like retrieval's expand.ts neighbor
 * lookups) rather than one-at-a-time — a frontier can carry up to
 * `fetchLimit` (frontier.ts, default 500) raw edges, and this runs before
 * that set is ranked/capped, so serializing would multiply round trips by
 * however many happen to be stale.
 */
export async function resolveStaleFrontierEdges(
  edges: Edge[],
  verifier: StructuralVerifier
): Promise<Edge[]> {
  const resolved = await Promise.all(
    edges.map((edge) => (edge.status === "stale" ? verifyStaleEdge(edge, verifier) : edge))
  );
  return resolved.filter((edge) => edge.status !== "invalid");
}
