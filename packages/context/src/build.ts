import { POSSIBLY_STALE_FLAG } from "@cognitive-memory/core";
import type {
  AgentContext,
  BuildContextOptions,
  ExperienceSummary,
  Subgraph,
} from "./types.js";

/**
 * Exported because a caller assembling the subgraph has to know this number:
 * `buildContext` sorts experiences by recency before applying the cap, so a
 * caller that hands in MORE than this many relevance-ranked memories loses the
 * lowest-recency ones regardless of how relevant they were (spec.md §24.2.1's
 * by-meaning hits are ranked, not recent). `packages/pipeline` clamps its own
 * experience budget to this.
 */
export const DEFAULT_MAX_EXPERIENCES = 10;

/**
 * subgraph -> spec.md §17's compact, task-specific projection. Pure
 * templating over what's already in `subgraph` — no I/O, no LLM call (that's
 * the point of this package: the retrieval decision already happened in
 * §24.2.1's by-meaning query, this only reshapes the result).
 */
export function buildContext(subgraph: Subgraph, task: string, options: BuildContextOptions = {}): AgentContext {
  const experiences: ExperienceSummary[] = [...(subgraph.experiences ?? [])]
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp) || a.id.localeCompare(b.id))
    .slice(0, options.maxExperiences ?? DEFAULT_MAX_EXPERIENCES)
    .map((e) => ({
      experienceId: e.id,
      task: e.task,
      lessons: e.lessons ?? [],
      result: e.result,
      // spec.md §24.2.3. Read straight off the memory rather than computed
      // here: `buildContext` does no I/O by contract (§17, "no new LLM call
      // required"), and deciding staleness needs a git lookup. Whoever assembled
      // the subgraph owns that — `packages/staleness`'s `flagPossiblyStale` at
      // read time, or the persisted sync-time verdict. Either way this stays
      // pure templating.
      ...(e.suspect
        ? { staleness: POSSIBLY_STALE_FLAG, stalenessReason: e.suspectReason }
        : {}),
    }));

  return { task, experiences };
}
