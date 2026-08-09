import { getFrontierEdges, getNodesByIds } from "@cognitive-memory/graph-store";
import { createStructuralVerifier, resolveStaleFrontierEdges, type StructuralVerifier } from "@cognitive-memory/staleness";
import type { GraphProvider } from "./types.js";

const DEFAULT_FRONTIER_FETCH_LIMIT = 500;

/**
 * Real Postgres-backed `GraphProvider` — a thin wrapper over graph-store's
 * batched frontier/node queries (spec.md §16: one CTE query per depth
 * level). `fetchLimit` is a raw-row safety cap, independent of `frontierCap`
 * on `TraverseOptions`, which caps the *ranked* shortlist actually handed to
 * the reasoner.
 *
 * `getFrontierEdges` now returns `stale` edges alongside `active` ones
 * (spec.md §12) — this is where they get resolved: each stale edge is
 * lazily verified before the frontier reaches ranking/reasoning, so
 * traversal never reasons over a fact that's since been invalidated, and a
 * still-valid fact rejoins as `active` instead of staying invisible
 * forever. `verifier` defaults to the real structural check but is
 * swappable (tests use a scripted fake, same pattern as `reasoner`).
 */
export function createPostgresGraphProvider(
  fetchLimit = DEFAULT_FRONTIER_FETCH_LIMIT,
  verifier: StructuralVerifier = createStructuralVerifier()
): GraphProvider {
  return {
    async getFrontier(nodeIds, excludeNeighborIds) {
      const raw = await getFrontierEdges(nodeIds, excludeNeighborIds, fetchLimit);
      const resolvedEdges = await resolveStaleFrontierEdges(raw.map((f) => f.edge), verifier);
      const resolvedById = new Map(resolvedEdges.map((edge) => [edge.id, edge]));
      return raw
        .filter((f) => resolvedById.has(f.edge.id))
        .map((f) => {
          const edge = resolvedById.get(f.edge.id);
          if (!edge) throw new Error(`unreachable: filtered for presence of ${f.edge.id}`);
          return { edge, neighborId: f.neighborId };
        });
    },
    async getNodes(ids) {
      return getNodesByIds(ids);
    },
  };
}
