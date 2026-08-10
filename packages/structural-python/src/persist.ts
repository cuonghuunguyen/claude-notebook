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
 * was there before. Identical rationale and logic to packages/structural's
 * persist.ts — kept as its own copy rather than a shared import so each
 * language extractor package stays additive/self-contained per spec.md §21
 * ("added as additional extractors... not a rewrite"), not coupled to
 * another language's package.
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
 * Same event-log feed and same transactional guarantee as
 * packages/structural's persistExtraction, run against the identical,
 * unmodified graph-store code.
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
