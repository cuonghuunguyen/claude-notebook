import type { Experience } from "@cognitive-memory/core";
import type { Subgraph } from "@cognitive-memory/context";
import { buildContext, DEFAULT_MAX_EXPERIENCES as CONTEXT_MAX_EXPERIENCES } from "@cognitive-memory/context";
import type { ScoredExperience } from "@cognitive-memory/episodic";
import { queryByMeaning } from "@cognitive-memory/episodic";
import { flagPossiblyStale, type StalenessVerdict } from "@cognitive-memory/staleness";
import type { PipelineOptions, PipelineResult } from "./types.js";

const DEFAULT_MAX_EXPERIENCES = 20;

/**
 * How many experiences this call may put into the subgraph.
 *
 * Clamped to `buildContext`'s own cap, because `buildContext` sorts
 * experiences by recency *before* truncating (packages/context/src/build.ts):
 * hand it more than it will keep, and it keeps the newest rather than the
 * best-matching. By-meaning hits arrive relevance-ordered (spec.md §24.2.1),
 * and the top-ranked answer to a "why" question is frequently an old commit.
 */
function experienceBudget(options: PipelineOptions): number {
  const pipelineCap = options.maxExperiences ?? DEFAULT_MAX_EXPERIENCES;
  const contextCap = options.contextOptions?.maxExperiences ?? CONTEXT_MAX_EXPERIENCES;
  return Math.min(pipelineCap, contextCap);
}

/**
 * spec.md §24.2.3's read-time staleness pass over exactly the memories that
 * are about to become context.
 *
 * Runs once, on the whole list: it is a single git walk for the batch
 * (`flagPossiblyStale`), and running it per memory would multiply the git cost
 * while producing the same verdicts.
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
 * task -> `AgentContext` (spec.md §22): the composition layer over §24.2.1's
 * by-meaning retrieval, §24.2.3's read-time staleness check and §17's
 * `buildContext`.
 *
 * ## Why there is no longer a structural stage
 *
 * Through M14 this function did five more things first: embed the task,
 * retrieve code seeds by hybrid lexical+vector search over structural nodes
 * (§9), traverse the symbol graph from those seeds under a reasoner's control
 * (§10), hydrate the nodes traversal reached, and hydrate the memories bound
 * to exactly those node ids — then interleave that node-gated memory list with
 * the by-meaning one under a shared budget.
 *
 * M15's gate measured what that stage was worth. Same corpus
 * (`colinhacks/zod`, `packages/zod/src/v4`), same ten hand-labelled "why"
 * questions, run twice: once against a database holding 501 extracted nodes
 * and 1171 edges, once against one holding none. By-meaning scored MRR 0.85
 * (recall 0.90) in *both*, and the node-gated arm scored 0.00 in both — it
 * returned ten memories per question with the graph present and never the
 * right one. Removing the stage therefore changes no measured outcome, which
 * is the only ground on which a stage should be removed. See `BENCHMARKS.md`.
 *
 * What that leaves is a shorter contract with one fewer way to fail: there is
 * no seed-miss short-circuit to get wrong, because "the graph has no node
 * matching this task" is no longer a thing that can be true (spec.md §24.3
 * records that conflation as §23's mistake).
 */
export async function runPipeline(task: string, options: PipelineOptions): Promise<PipelineResult> {
  const maxExperiences = experienceBudget(options);

  // Step 1: compute the task embedding at most once, and hand the vector leg
  // the cached vector rather than letting it embed the same string again.
  const taskEmbedding = options.embedder ? await options.embedder.embed(task) : undefined;

  // Step 2: retrieve by meaning (spec.md §24.2.1).
  const byMeaning = await retrieveByMeaning(task, options, taskEmbedding, maxExperiences);

  // Step 3: spec.md §24.2.3 — flag what the history has overtaken.
  const flagged = await applyStaleness(
    byMeaning.map((hit) => hit.experience).slice(0, maxExperiences),
    options
  );

  // Step 4.
  const subgraph: Subgraph = { experiences: flagged.experiences };
  const context = buildContext(subgraph, task, options.contextOptions);

  return { context, byMeaning, staleness: flagged.staleness };
}

/** Step 2's body: spec.md §24.2.1's by-meaning query. */
async function retrieveByMeaning(
  task: string,
  options: PipelineOptions,
  taskEmbedding: number[] | undefined,
  budget: number
): Promise<ScoredExperience[]> {
  return queryByMeaning(task, {
    ...(options.byMeaning ?? {}),
    // After the spread, not before: `limit` is the clamp `experienceBudget`
    // exists to enforce, so a caller-supplied `byMeaning.limit` must not be
    // able to defeat it. Everything else (legLimit, weights, includeCold) is
    // genuinely the caller's business.
    limit: budget,
    // Reuses §22 step 1's single embedding — never a second embed() call for
    // the same task string. `queryEmbedding` takes precedence over `embedder`
    // inside `queryByMeaning`, so no provider is forwarded: there is nothing
    // left for it to embed.
    queryEmbedding: taskEmbedding,
  });
}
