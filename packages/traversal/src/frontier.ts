import { getFrontierEdges, getNodesByIds } from "@cognitive-memory/graph-store";
import type { GraphProvider } from "./types.js";

const DEFAULT_FRONTIER_FETCH_LIMIT = 500;

/**
 * Real Postgres-backed `GraphProvider` — a thin wrapper over graph-store's
 * batched frontier/node queries (spec.md §16: one CTE query per depth
 * level). `fetchLimit` is a raw-row safety cap, independent of `frontierCap`
 * on `TraverseOptions`, which caps the *ranked* shortlist actually handed to
 * the reasoner.
 */
export function createPostgresGraphProvider(fetchLimit = DEFAULT_FRONTIER_FETCH_LIMIT): GraphProvider {
  return {
    async getFrontier(nodeIds, excludeNeighborIds) {
      return getFrontierEdges(nodeIds, excludeNeighborIds, fetchLimit);
    },
    async getNodes(ids) {
      return getNodesByIds(ids);
    },
  };
}
