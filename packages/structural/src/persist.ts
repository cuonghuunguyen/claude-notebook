import type { Node } from "@cognitive-memory/core";
import {
  appendEvent,
  getNodesByIds,
  getPool,
  markEdgesStaleForNode,
  upsertEdgeByTriple,
  upsertNode,
} from "@cognitive-memory/graph-store";
import type { ExtractionResult } from "./extract.js";

/**
 * Whether a re-extracted node's persisted fields actually differ from what
 * was there before — used to distinguish a genuine source change (name,
 * path, summary, or metadata differs; e.g. a plain rename, which keeps the
 * same id per spec.md §3.2's shape-fingerprint identity) from a no-op
 * upsert of an unchanged node that merely shared a changed file with
 * something else. Only a real change should mark dependent semantic edges
 * stale (spec.md §12) — an unrelated sibling symbol re-extracted from the
 * same file must not.
 */
function nodeContentChanged(previous: Node, next: Node): boolean {
  return (
    previous.name !== next.name ||
    previous.path !== next.path ||
    previous.summary !== next.summary ||
    JSON.stringify(previous.metadata) !== JSON.stringify(next.metadata)
  );
}

/**
 * Nodes before edges — edges FK-reference nodes (migrations/0001_init.sql).
 *
 * This is the single choke point every structural write (initial full
 * extraction and incremental.ts's changed-file re-extraction alike) funnels
 * through, so it's also the single place spec.md §14's event log gets fed
 * for structural writes: `SymbolAdded` for a genuinely new node,
 * `CodeChanged` for an existing node whose content changed (plus marking
 * its dependent semantic edges stale per spec.md §12 — done here, before
 * this function's own edge loop re-persists this node's structural edges as
 * `active` again), `RelationAdded` for every persisted edge.
 * `SymbolRemoved` is emitted by incremental.ts instead — a removed node
 * never appears in `result.nodes` at all, so this function never sees it.
 *
 * Runs as one transaction: a mutation committing while its event fails to
 * append (or vice versa) would desync the materialized graph from the event
 * log it's supposed to be a projection of (spec.md §14) — exactly what
 * graph-store's rebuild-from-events test exists to catch. `previous` nodes
 * are batch-fetched once via `getNodesByIds` rather than one `getNodeById`
 * per node, matching the batching principle spec.md §10/§16 already apply
 * elsewhere (traversal's frontier hydration) — a full extraction can touch
 * thousands of nodes.
 */
export async function persistExtraction(
  result: ExtractionResult,
  repoId: string
): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const previousById = new Map(
      (await getNodesByIds(result.nodes.map((n) => n.id), { includeDeleted: true, db: client })).map(
        (n) => [n.id, n] as const
      )
    );

    for (const node of result.nodes) {
      const previous = previousById.get(node.id);
      const saved = await upsertNode(node, repoId, client);
      if (!previous) {
        await appendEvent({ eventType: "SymbolAdded", payload: { node: saved, repoId } }, client);
      } else if (nodeContentChanged(previous, saved)) {
        await appendEvent({ eventType: "CodeChanged", payload: { node: saved, repoId } }, client);
        await markEdgesStaleForNode(saved.id, client);
      }
    }
    for (const edge of result.edges) {
      const saved = await upsertEdgeByTriple(edge, client);
      await appendEvent({ eventType: "RelationAdded", payload: { edge: saved } }, client);
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
