import type { Node } from "@cognitive-memory/core";
import { searchNodesByEmbedding, searchNodesByTrigram } from "@cognitive-memory/graph-store";
import { expandSeeds } from "./expand.js";
import { mergeHits } from "./merge.js";
import type { RetrieveOptions, SeedNode } from "./types.js";

const DEFAULT_EXPANSION_SEED_COUNT = 3;
const DEFAULT_LEG_LIMIT = 10;
const DEFAULT_NEIGHBOR_LIMIT = 10;
const DEFAULT_LEXICAL_THRESHOLD = 0.1;

/**
 * query -> seed nodes (spec.md §9): lexical leg (pg_trgm) + vector leg
 * (injected embedder, skipped if none is provided) merged and de-duped,
 * then expanded with 1-hop structural/semantic neighbors so the seed set
 * isn't capped at raw top-K search hits.
 */
export async function retrieveSeeds(
  query: string,
  options: RetrieveOptions = {}
): Promise<SeedNode[]> {
  const legLimit = options.legLimit ?? DEFAULT_LEG_LIMIT;
  const expansionSeedCount = options.expansionSeedCount ?? DEFAULT_EXPANSION_SEED_COUNT;
  const neighborLimit = options.neighborLimit ?? DEFAULT_NEIGHBOR_LIMIT;
  const lexicalThreshold = options.lexicalThreshold ?? DEFAULT_LEXICAL_THRESHOLD;

  // Independent I/O — run both legs concurrently rather than serializing the
  // lexical query behind the embed-then-search vector leg.
  const [lexicalHits, vectorHits] = await Promise.all([
    searchNodesByTrigram(query, legLimit, lexicalThreshold, options.repoId),
    options.embedder
      ? options.embedder
          .embed(query)
          .then((embedding) => searchNodesByEmbedding(embedding, legLimit, options.repoId))
      : Promise.resolve([]),
  ]);

  const nodesById = new Map<string, Node>();
  for (const hit of [...lexicalHits, ...vectorHits]) nodesById.set(hit.node.id, hit.node);

  const merged = mergeHits(lexicalHits, vectorHits);
  return expandSeeds(merged, nodesById, { expansionSeedCount, neighborLimit });
}
