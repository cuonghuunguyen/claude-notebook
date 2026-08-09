import { upsertEdgeByTriple, upsertNode } from "@cognitive-memory/graph-store";
import type { ExtractionResult } from "./extract.js";

/** Nodes before edges — edges FK-reference nodes (migrations/0001_init.sql). */
export async function persistExtraction(result: ExtractionResult): Promise<void> {
  for (const node of result.nodes) {
    await upsertNode(node);
  }
  for (const edge of result.edges) {
    await upsertEdgeByTriple(edge);
  }
}
