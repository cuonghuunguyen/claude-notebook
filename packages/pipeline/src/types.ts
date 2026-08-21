import type { EmbeddingProvider } from "@cognitive-memory/core";
import type { AgentContext, BuildContextOptions } from "@cognitive-memory/context";
import type { QueryByMeaningOptions, ScoredExperience } from "@cognitive-memory/episodic";
import type { StalenessVerdict } from "@cognitive-memory/staleness";

/**
 * spec.md §22, as it stands after M15: composes §24.2.1's by-meaning retrieval,
 * §24.2.3's read-time staleness check and §17's context construction into one
 * entry point.
 *
 * §22 originally composed §9's `retrieveSeeds`, §10's `traverse` and §17's
 * `buildContext` — retrieve code seeds, walk the symbol graph, hydrate the
 * memories bound to the nodes it reached. M15 removed that path entirely, on
 * the measurement in `BENCHMARKS.md`: on the same corpus and the same ten
 * hand-labelled "why" questions, the node-gated arm found the answering commit
 * 0 times out of 10 whether the graph held 501 nodes or none, while by-meaning
 * scored MRR 0.85 identically in both conditions. A stage that cannot change
 * an outcome is not a stage.
 */
export interface PipelineOptions {
  /**
   * Shared with the by-meaning vector leg — computed at most once per
   * `runPipeline` call (spec.md §22 step 1), never independently per stage.
   */
  embedder?: EmbeddingProvider;
  contextOptions?: BuildContextOptions;
  /**
   * Flat cap on hydrated experiences, keeping this bounded the same way §17's
   * own DEFAULT_MAX_* caps bound `buildContext`'s output. Default 20.
   *
   * The effective cap is `min(this, contextOptions.maxExperiences ?? 10)`:
   * `buildContext` sorts experiences by recency *before* truncating, so
   * anything handed to it beyond its own cap is dropped by date rather than by
   * relevance — which would silently discard the best by-meaning hit, because
   * the memory that answers a "why" question is usually an old one. Raise
   * `contextOptions.maxExperiences` too if you want more than 10 through.
   */
  maxExperiences?: number;
  /**
   * Overrides for by-meaning experience retrieval (spec.md §24.2.1): match the
   * task against experience *text*.
   *
   * `embedder` and `queryEmbedding` are supplied by `runPipeline` itself from
   * the single task embedding of §22 step 1 — setting them here has no effect.
   *
   * Until M15 this option also accepted `false`, which reproduced the pre-M11
   * node-gated-only behaviour for `eval/why-spike`'s baseline arm. There is no
   * node-gated path left to fall back to, so the flag went with it: turning
   * by-meaning off now would mean "retrieve nothing".
   */
  byMeaning?: Omit<QueryByMeaningOptions, "embedder" | "queryEmbedding">;
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
  /**
   * The by-meaning hits, with their fusion scores and matching legs — the
   * ranking `context.experiences` loses when `buildContext` re-sorts by
   * recency (spec.md §24.2.1).
   */
  byMeaning: ScoredExperience[];
  /**
   * Per-memory staleness verdicts for the experiences handed to `buildContext`
   * (spec.md §24.2.3). Empty when `stalenessRepoDir` was not given, and empty
   * when the git lookup failed — staleness never fails a retrieval.
   *
   * **Key these by `experience.id`, never by position.** They are in pipeline
   * order (relevance-ranked), while `context.experiences` is re-sorted by
   * recency inside `buildContext` and then truncated — so index `i` of one is
   * routinely a different memory than index `i` of the other. That is the
   * normal case, not an edge case: the top-ranked by-meaning answer is
   * frequently an old commit.
   *
   * Surfaced because a caller that wants to act on staleness — M13's
   * read-repair especially — needs the matching commits, not just the rendered
   * warning string.
   */
  staleness: StalenessVerdict[];
}
