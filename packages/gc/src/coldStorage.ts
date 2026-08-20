import {
  getEdgesTouchingNode,
  getNodesByIds,
  listWarmExperienceRefs,
  markExperienceCold,
} from "@cognitive-memory/graph-store";

/**
 * spec.md §18: "experiences whose lessons were promoted to durable semantic
 * edges (§7) are moved to cold storage." Semantic "stage" is deliberately
 * not a persisted column (packages/semantic/src/edge.ts's design note: it's
 * recomputed from provenance, not stored) — the closest persisted proxy for
 * "reached durable" is `lastVerifiedAt` being set, since spec.md §7's
 * durable path 1 is an explicit verification pass, and that's the field
 * verification actually writes. This is an approximation, not an exact
 * stage lookup; documented here rather than silently assumed.
 */
async function isPromotedToDurable(nodeId: string): Promise<boolean> {
  const edges = await getEdgesTouchingNode(nodeId);
  // `status === "active"` matters here, not just `lastVerifiedAt != null`:
  // lazy verification (spec.md §12) can later invalidate a
  // previously-verified edge without clearing `lastVerifiedAt`
  // (`markEdgeInvalid` only flips status) — a since-invalidated edge is a
  // dead reference, not evidence the knowledge is still durable.
  return edges.some((edge) => edge.lastVerifiedAt != null && edge.status === "active");
}

/**
 * An experience is eligible for cold storage once EVERY structural node it's
 * related to already has a durable(-proxy) semantic edge — if even one has no
 * such edge yet, the experience's lessons about that node are still the only
 * route to that knowledge and must stay in the hot path.
 *
 * "Structural node" is load-bearing since spec.md §24.2.2: `relatedNodes` now
 * also carries plain-text anchors (`packages/capture` writes the paths a mined
 * commit touched), and a path is not a node id — `getEdgesTouchingNode("src/
 * parse.ts")` returns nothing, so a naive read would find every text-anchored
 * memory un-promotable and quietly turn this function into a no-op for the
 * whole knowledge layer. Entries that do not resolve to a node are therefore
 * skipped rather than counted as unpromoted, which keeps the pre-§24 behaviour
 * exactly for node-id-anchored memories. A memory anchored ONLY to text has no
 * structural evidence to judge and stays warm; giving that case a retention
 * signal is ROADMAP M16's job, not this function's.
 */
export async function markPromotedExperiencesCold(): Promise<number> {
  const refs = await listWarmExperienceRefs();
  let marked = 0;
  for (const ref of refs) {
    if (ref.relatedNodes.length === 0) continue;
    const nodeIds = (await getNodesByIds(ref.relatedNodes)).map((node) => node.id);
    if (nodeIds.length === 0) continue;
    const promotedFlags = await Promise.all(nodeIds.map(isPromotedToDurable));
    if (promotedFlags.every(Boolean)) {
      await markExperienceCold(ref.id);
      marked += 1;
    }
  }
  return marked;
}
