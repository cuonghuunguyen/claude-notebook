import type { Experience, Node } from "@cognitive-memory/core";
import type { Subgraph } from "@cognitive-memory/context";
import { buildContext } from "@cognitive-memory/context";
import { queryByNode } from "@cognitive-memory/episodic";
import { getNodesByIds } from "@cognitive-memory/graph-store";
import type { EmbeddingProvider } from "@cognitive-memory/retrieval";
import { retrieveSeeds } from "@cognitive-memory/retrieval";
import type { TraversalResult } from "@cognitive-memory/traversal";
import { traverse } from "@cognitive-memory/traversal";
import type { PipelineOptions, PipelineResult } from "./types.js";

const DEFAULT_MAX_EXPERIENCES = 20;

/** Same shape `traverse()` itself returns for a zero-seed call (spec.md §22 point 3) — reproduced literally here instead of calling `traverse`, so the empty-seed short-circuit never touches the injected `graph`/`reasoner` at all. */
const EMPTY_TRAVERSAL_RESULT: TraversalResult = {
  nodeIds: [],
  edges: [],
  depthReached: 0,
  reasoningStepsUsed: 0,
  stopReason: "no_frontier",
};

/**
 * Fetches prior experiences touching any of `nodeIds`, deduped by
 * experience id, truncated to `maxExperiences` most-recent (spec.md §22
 * step 6). Deliberately not reusing `@cognitive-memory/context`'s own
 * `hydrateExperiences` — that helper has no truncation, and this cap is
 * the pipeline's own bound, independent of `buildContext`'s later one.
 */
async function hydrateRecentExperiences(nodeIds: string[], maxExperiences: number): Promise<Experience[]> {
  const lists = await Promise.all(nodeIds.map((id) => queryByNode(id)));
  const byId = new Map<string, Experience>();
  for (const experience of lists.flat()) byId.set(experience.id, experience);
  return [...byId.values()]
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp) || a.id.localeCompare(b.id))
    .slice(0, maxExperiences);
}

/**
 * task -> `AgentContext` (spec.md §22): the composition layer over §9's
 * `retrieveSeeds`, §10's `traverse`, and §17's `buildContext` that no code
 * in the workspace previously provided. See spec.md §22 for the full
 * step-by-step contract this function implements.
 */
export async function runPipeline(task: string, options: PipelineOptions): Promise<PipelineResult> {
  const maxExperiences = options.maxExperiences ?? DEFAULT_MAX_EXPERIENCES;

  // Step 1: compute the task embedding at most once, and hand retrieval a
  // shim `EmbeddingProvider` that just returns the cached vector — this way
  // retrieveSeeds's own internal `embedder.embed(query)` call (spec.md §9)
  // and traversal's `taskEmbedding` term (§11) both see the same vector
  // without a second real embed() call.
  const taskEmbedding = options.embedder ? await options.embedder.embed(task) : undefined;
  const cachedEmbedder: EmbeddingProvider | undefined = taskEmbedding
    ? { embed: async () => taskEmbedding }
    : undefined;

  // Step 2.
  const seeds = await retrieveSeeds(task, {
    repoId: options.repoId,
    embedder: cachedEmbedder,
    ...options.retrieveOptions,
  });

  // Step 3: empty-seed short-circuit — never call traverse() at all.
  if (seeds.length === 0) {
    const emptySubgraph: Subgraph = { nodes: [], edges: [], experiences: [] };
    const context = buildContext(emptySubgraph, task, options.contextOptions);
    return { context, seeds, traversal: EMPTY_TRAVERSAL_RESULT };
  }

  // Step 4.
  const traversal = await traverse(
    seeds.map((s) => s.nodeId),
    task,
    {
      graph: options.graph,
      reasoner: options.reasoner,
      taskEmbedding,
      ...options.traverseOptions,
    }
  );

  // Step 5. `getNodesByIds` has no ORDER BY (packages/graph-store), so its
  // result order doesn't necessarily match `traversal.nodeIds` — which IS
  // priority-ordered (highest-relevance discovered first). `buildContext`
  // truncates each section BEFORE sorting, on the stated assumption that
  // input order is the priority signal (packages/context/src/build.ts), so
  // re-sort the hydrated nodes back into `traversal.nodeIds`'s order here or
  // that truncation silently keeps arbitrary nodes instead of the most
  // relevant ones whenever a subgraph exceeds a section's cap.
  const hydratedById = new Map((await getNodesByIds(traversal.nodeIds)).map((n) => [n.id, n]));
  const nodes = traversal.nodeIds
    .map((id) => hydratedById.get(id))
    .filter((n): n is Node => n !== undefined);

  // Step 6.
  const experiences = await hydrateRecentExperiences(
    nodes.map((n) => n.id),
    maxExperiences
  );

  // Step 7.
  const subgraph: Subgraph = { nodes, edges: traversal.edges, experiences };
  const context = buildContext(subgraph, task, options.contextOptions);

  return { context, seeds, traversal };
}
