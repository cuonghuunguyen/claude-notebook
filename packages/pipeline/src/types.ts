import type { AgentContext, BuildContextOptions } from "@cognitive-memory/context";
import type { QueryByMeaningOptions, ScoredExperience } from "@cognitive-memory/episodic";
import type { EmbeddingProvider, RetrieveOptions, SeedNode } from "@cognitive-memory/retrieval";
import type { StalenessVerdict } from "@cognitive-memory/staleness";
import type { GraphProvider, ReasoningProvider, TraversalResult, TraverseOptions } from "@cognitive-memory/traversal";

/** spec.md §22: composes retrieval (§9) / traversal (§10) / context (§17) into one entry point. */
export interface PipelineOptions {
  repoId?: string;
  /**
   * Shared with both retrieval's vector leg and traversal's ranking term —
   * computed at most once per `runPipeline` call (spec.md §22 step 1), never
   * independently by each stage, so the two stages can't disagree about
   * what "semantically relevant to this task" means for the same call.
   */
  embedder?: EmbeddingProvider;
  graph: GraphProvider;
  reasoner: ReasoningProvider;
  retrieveOptions?: Omit<RetrieveOptions, "embedder" | "repoId">;
  traverseOptions?: Omit<TraverseOptions, "graph" | "reasoner" | "taskEmbedding">;
  contextOptions?: BuildContextOptions;
  /**
   * Flat cap on hydrated experiences across the whole subgraph, independent
   * of node count — keeps this bounded the same way §17's own DEFAULT_MAX_*
   * caps bound `buildContext`'s output. Default 20.
   *
   * The effective cap is `min(this, contextOptions.maxExperiences ?? 10)`:
   * `buildContext` sorts experiences by recency *before* truncating, so
   * anything handed to it beyond its own cap is dropped by date rather than by
   * relevance — which since M11 would silently discard the best by-meaning hit,
   * because the memory that answers a "why" question is usually an old one.
   * Raise `contextOptions.maxExperiences` too if you want more than 10 through.
   */
  maxExperiences?: number;
  /**
   * By-meaning experience retrieval (spec.md §24.2.1 / ROADMAP.md M11): match
   * the task against experience *text*, independent of any node hit.
   *
   * On by default, and deliberately so — this is the measured-stronger half of
   * the memory (MRR 0.75 vs 0.13 for node-gated hydration,
   * `WHY_MEMORY_SPIKE.md`). Pass `false` to get the pre-M11 node-gated-only
   * behaviour, which is what the node-gated baseline in `eval/why-spike` needs.
   *
   * `embedder` and `queryEmbedding` are supplied by `runPipeline` itself from
   * the single task embedding of §22 step 1 — setting them here has no effect.
   */
  byMeaning?: boolean | Omit<QueryByMeaningOptions, "embedder" | "queryEmbedding">;
  /**
   * Absolute path to a git work tree for the repo these memories describe.
   * Given, `runPipeline` runs spec.md §24.2.3's read-time staleness check over
   * the experiences it is about to hand to `buildContext`, so a memory the
   * history has overtaken arrives tagged `possibly-stale — verify before
   * trusting` instead of silently trusted.
   *
   * Optional because the pipeline is usable against a database with no
   * checkout in reach (a hosted retrieval service, an eval harness replaying a
   * corpus). Omitted, memories still carry whatever verdict the last
   * `markSuspectFromHistory` sync persisted — read-time flagging catches what
   * has happened *since* that sync, it is not the only source of the flag.
   */
  stalenessRepoDir?: string;
  /** Max commits the staleness walk reads. Default 1000. */
  stalenessCommitLimit?: number;
}

export interface PipelineResult {
  context: AgentContext;
  /** Surfaced for callers/eval harnesses that need to see *why* — spec.md §9. */
  seeds: SeedNode[];
  /** Surfaced for callers/eval harnesses that need to see *why* — spec.md §10. */
  traversal: TraversalResult;
  /**
   * The by-meaning hits, with their fusion scores and matching legs — the
   * ranking `context.experiences` loses when `buildContext` re-sorts by
   * recency. Empty when `byMeaning` is disabled (spec.md §24.2.1).
   */
  byMeaning: ScoredExperience[];
  /**
   * Per-memory staleness verdicts for the experiences handed to `buildContext`
   * (spec.md §24.2.3). Empty when `stalenessRepoDir` was not given, and empty
   * when the git lookup failed — staleness never fails a retrieval.
   *
   * **Key these by `experience.id`, never by position.** They are in pipeline
   * order (relevance-interleaved), while `context.experiences` is re-sorted by
   * recency inside `buildContext` and then truncated — so index `i` of one is
   * routinely a different memory than index `i` of the other. That is the
   * normal case, not an edge case: the top-ranked by-meaning answer is
   * frequently an old commit.
   *
   * Surfaced for the same reason `seeds` and `traversal` are: a caller that
   * wants to act on staleness — M13's read-repair especially — needs the
   * matching commits, not just the rendered warning string.
   */
  staleness: StalenessVerdict[];
}
