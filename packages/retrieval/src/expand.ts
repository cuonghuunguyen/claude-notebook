import type { Node, RelationType } from "@cognitive-memory/core";
import { SEMANTIC_RELATIONS, STRUCTURAL_RELATIONS } from "@cognitive-memory/core";
import { getNeighborEdgesByRelation } from "@cognitive-memory/graph-store";
import type { SeedNode } from "./types.js";

/**
 * Seed expansion beyond top-K (spec.md §9, closing v0.1's review gap #7): a
 * node can be a poor initial search hit but highly relevant once reached.
 * Adds two things to the merged lexical+vector result:
 *
 * - the 1-hop structural neighbors of the top `expansionSeedCount` hits
 *   (the file containing a matched function, the interface it implements)
 * - the highest-weight semantic neighbors of any matched concept/invariant
 *   node (so matching an invariant surfaces the subsystem it constrains)
 *
 * Neighbors already present in `merged` are left with their original score
 * and reason — expansion only adds nodes the direct search legs missed.
 */
export async function expandSeeds(
  merged: SeedNode[],
  nodesById: Map<string, Node>,
  opts: { expansionSeedCount: number; neighborLimit: number }
): Promise<SeedNode[]> {
  const seen = new Set(merged.map((s) => s.nodeId));
  const additions: SeedNode[] = [];

  async function addNeighbors(
    nodeId: string,
    relations: readonly RelationType[],
    reason: SeedNode["reason"]
  ): Promise<void> {
    const edges = await getNeighborEdgesByRelation(nodeId, relations, opts.neighborLimit);
    for (const edge of edges) {
      const neighborId = edge.from === nodeId ? edge.to : edge.from;
      if (seen.has(neighborId)) continue;
      seen.add(neighborId);
      additions.push({ nodeId: neighborId, score: edge.weight, reason });
    }
  }

  const topHits = merged.slice(0, opts.expansionSeedCount);
  const semanticSeeds = merged.filter((hit) => {
    const node = nodesById.get(hit.nodeId);
    return node?.type === "concept" || node?.type === "invariant";
  });

  // Each lookup is an independent Postgres round trip — run them concurrently
  // rather than serializing per top-hit / per-matched-concept. Safe to share
  // `seen`/`additions` across the concurrent calls: JS has no preemption
  // within a synchronous block, and the loop that mutates them contains no
  // `await`, so each addNeighbors call's mutations are atomic relative to
  // the others.
  await Promise.all([
    ...topHits.map((hit) => addNeighbors(hit.nodeId, STRUCTURAL_RELATIONS, "structural_neighbor")),
    ...semanticSeeds.map((hit) => addNeighbors(hit.nodeId, SEMANTIC_RELATIONS, "semantic_neighbor")),
  ]);

  // Re-sort: mergeHits establishes score-descending order, and additions
  // (scored by edge weight) can outscore a near-threshold direct hit —
  // appending them unsorted would silently break that ordering for any
  // caller that slices the top N off the result.
  return [...merged, ...additions].sort((a, b) => b.score - a.score);
}
