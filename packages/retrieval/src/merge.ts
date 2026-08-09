import type { NodeSearchHit } from "@cognitive-memory/graph-store";
import type { SeedNode } from "./types.js";

/**
 * Merges the lexical and vector legs (spec.md §9) into one de-duped, ranked
 * list. A node hit by both legs is a stronger signal than either alone, so
 * it's tagged `hybrid_match` and scored by its best leg rather than by
 * summing two differently-scaled similarity measures.
 */
export function mergeHits(lexical: NodeSearchHit[], vector: NodeSearchHit[]): SeedNode[] {
  const lexicalScore = new Map(lexical.map((h) => [h.node.id, h.score]));
  const vectorScore = new Map(vector.map((h) => [h.node.id, h.score]));
  const ids = new Set([...lexicalScore.keys(), ...vectorScore.keys()]);

  const merged: SeedNode[] = [];
  for (const nodeId of ids) {
    const l = lexicalScore.get(nodeId);
    const v = vectorScore.get(nodeId);
    if (l !== undefined && v !== undefined) {
      merged.push({ nodeId, score: Math.max(l, v), reason: "hybrid_match" });
    } else if (l !== undefined) {
      merged.push({ nodeId, score: l, reason: "lexical_match" });
    } else {
      merged.push({ nodeId, score: v as number, reason: "semantic_match" });
    }
  }

  return merged.sort((a, b) => b.score - a.score);
}
