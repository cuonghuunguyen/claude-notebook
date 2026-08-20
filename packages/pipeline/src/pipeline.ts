import type { Experience, Node } from "@cognitive-memory/core";
import type { Subgraph } from "@cognitive-memory/context";
import { buildContext, DEFAULT_MAX_EXPERIENCES as CONTEXT_MAX_EXPERIENCES } from "@cognitive-memory/context";
import type { ScoredExperience } from "@cognitive-memory/episodic";
import { queryByMeaning, queryByNode } from "@cognitive-memory/episodic";
import { getNodesByIds } from "@cognitive-memory/graph-store";
import type { EmbeddingProvider } from "@cognitive-memory/retrieval";
import { retrieveSeeds } from "@cognitive-memory/retrieval";
import { flagPossiblyStale, type StalenessVerdict } from "@cognitive-memory/staleness";
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
 * How many experiences this call may put into the subgraph.
 *
 * Clamped to `buildContext`'s own cap, because `buildContext` sorts
 * experiences by recency *before* truncating (packages/context/src/build.ts):
 * hand it more than it will keep, and it keeps the newest rather than the
 * best-matching. That was harmless while every experience arrived
 * recency-ordered from node hydration; it is not harmless now that
 * by-meaning hits arrive relevance-ordered (spec.md §24.2.1), because the
 * top-ranked answer to the task is frequently an old commit.
 */
function experienceBudget(options: PipelineOptions): number {
  const pipelineCap = options.maxExperiences ?? DEFAULT_MAX_EXPERIENCES;
  const contextCap = options.contextOptions?.maxExperiences ?? CONTEXT_MAX_EXPERIENCES;
  return Math.min(pipelineCap, contextCap);
}

/**
 * Interleaves the two memory sources round-robin, by-meaning first.
 *
 * By-meaning goes first because it is the measured-stronger signal (MRR 0.75
 * vs 0.13, `WHY_MEMORY_SPIKE.md`), but it does not get the whole budget:
 * node-hydrated experiences are the ones bound to code the traversal actually
 * reached, and a task about a specific file should still see them even when
 * the task wording matches other memories better. Taking alternately means
 * neither source can starve the other, whatever the budget is.
 */
function interleaveExperiences(
  byMeaning: Experience[],
  nodeHydrated: Experience[],
  budget: number
): Experience[] {
  const picked = new Map<string, Experience>();
  for (let i = 0; picked.size < budget && (i < byMeaning.length || i < nodeHydrated.length); i++) {
    for (const candidate of [byMeaning[i], nodeHydrated[i]]) {
      if (candidate && !picked.has(candidate.id) && picked.size < budget) {
        picked.set(candidate.id, candidate);
      }
    }
  }
  return [...picked.values()];
}

/**
 * spec.md §24.2.3's read-time staleness pass over exactly the memories that
 * are about to become context.
 *
 * Runs once, on the merged list, rather than once per memory source: it is a
 * single git walk for the whole batch (`flagPossiblyStale`), and running it
 * twice would double the git cost while producing the same verdicts.
 *
 * Placed after the experience budget is applied, not before. Staleness is not a
 * ranking signal — a flagged memory is still returned (§24.2.3) — so checking
 * memories that were never going to fit in the context would only widen the
 * `--since` window and slow the walk down.
 */
async function applyStaleness(
  experiences: Experience[],
  options: PipelineOptions
): Promise<{ experiences: Experience[]; staleness: StalenessVerdict[] }> {
  if (!options.stalenessRepoDir || experiences.length === 0) {
    return { experiences, staleness: [] };
  }
  let verdicts: StalenessVerdict[];
  try {
    verdicts = await flagPossiblyStale(experiences, {
      repoDir: options.stalenessRepoDir,
      limit: options.stalenessCommitLimit,
    });
  } catch {
    // Staleness is an advisory annotation, and an annotation must not be able
    // to break the thing it annotates. `stalenessRepoDir` pointing at a
    // non-repository, a repo with no commits yet, `git` missing from PATH, or a
    // `--name-status` dump past execFile's maxBuffer would otherwise turn every
    // retrieval into a hard failure — losing the memory entirely, which
    // §24.2.3 treats as the more expensive error than an unverified memory.
    // Degrades to "no verdicts", i.e. exactly the no-checkout behaviour.
    return { experiences, staleness: [] };
  }
  // `flagPossiblyStale` returns one verdict per input in input order and
  // re-emits the memory with `suspect` set, so mapping straight through keeps
  // the context's experience order (and therefore `buildContext`'s truncation)
  // exactly as it was.
  return { experiences: verdicts.map((v) => v.experience), staleness: verdicts };
}

/**
 * task -> `AgentContext` (spec.md §22): the composition layer over §9's
 * `retrieveSeeds`, §10's `traverse`, and §17's `buildContext` that no code
 * in the workspace previously provided. See spec.md §22 for the full
 * step-by-step contract this function implements.
 */
export async function runPipeline(task: string, options: PipelineOptions): Promise<PipelineResult> {
  const maxExperiences = experienceBudget(options);

  // Step 1: compute the task embedding at most once, and hand retrieval a
  // shim `EmbeddingProvider` that just returns the cached vector — this way
  // retrieveSeeds's own internal `embedder.embed(query)` call (spec.md §9)
  // and traversal's `taskEmbedding` term (§11) both see the same vector
  // without a second real embed() call.
  const taskEmbedding = options.embedder ? await options.embedder.embed(task) : undefined;
  const cachedEmbedder: EmbeddingProvider | undefined = taskEmbedding
    ? { embed: async () => taskEmbedding }
    : undefined;

  // Step 2. The by-meaning query runs concurrently with seed retrieval rather
  // than after it: it consumes nothing the structural side produces (that is
  // the whole point of spec.md §24.2.1), so serializing it would add its
  // latency to every call for no reason.
  const [seeds, byMeaning] = await Promise.all([
    retrieveSeeds(task, {
      repoId: options.repoId,
      embedder: cachedEmbedder,
      ...options.retrieveOptions,
    }),
    retrieveByMeaning(task, options, taskEmbedding, maxExperiences),
  ]);
  const byMeaningExperiences = byMeaning.map((hit) => hit.experience);

  // Step 3: empty-seed short-circuit — never call traverse() at all.
  //
  // Pre-M11 this returned an empty context. It no longer can: knowledge
  // retrieval does not depend on a structural seed hit, so "the graph has no
  // node matching this task" must not also mean "the memory has nothing to
  // say about it" — that conflation is exactly what spec.md §24.3 records as
  // §23's mistake.
  if (seeds.length === 0) {
    const flagged = await applyStaleness(
      byMeaningExperiences.slice(0, maxExperiences),
      options
    );
    const knowledgeOnly: Subgraph = {
      nodes: [],
      edges: [],
      experiences: flagged.experiences,
    };
    const context = buildContext(knowledgeOnly, task, options.contextOptions);
    return {
      context,
      seeds,
      traversal: EMPTY_TRAVERSAL_RESULT,
      byMeaning,
      staleness: flagged.staleness,
    };
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

  // Step 6. Both memory sources, merged under one budget.
  const nodeHydrated = await hydrateRecentExperiences(
    nodes.map((n) => n.id),
    maxExperiences
  );
  const experiences = interleaveExperiences(byMeaningExperiences, nodeHydrated, maxExperiences);

  // Step 6b: spec.md §24.2.3 — flag what the history has overtaken.
  const flagged = await applyStaleness(experiences, options);

  // Step 7.
  const subgraph: Subgraph = { nodes, edges: traversal.edges, experiences: flagged.experiences };
  const context = buildContext(subgraph, task, options.contextOptions);

  return { context, seeds, traversal, byMeaning, staleness: flagged.staleness };
}

/** Step 2b: spec.md §24.2.1's by-meaning leg, unless the caller turned it off. */
async function retrieveByMeaning(
  task: string,
  options: PipelineOptions,
  taskEmbedding: number[] | undefined,
  budget: number
): Promise<ScoredExperience[]> {
  if (options.byMeaning === false) return [];
  const overrides = typeof options.byMeaning === "object" ? options.byMeaning : {};
  return queryByMeaning(task, {
    ...overrides,
    // After the spread, not before: `limit` is the clamp `experienceBudget`
    // exists to enforce, so a caller-supplied `byMeaning.limit` must not be
    // able to defeat it. Everything else in `overrides` (legLimit, weights,
    // includeCold) is genuinely the caller's business.
    limit: budget,
    // Reuses §22 step 1's single embedding — never a second embed() call for
    // the same task string.
    queryEmbedding: taskEmbedding,
  });
}
