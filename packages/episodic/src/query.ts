import type { Experience } from "@cognitive-memory/core";
import {
  queryExperiencesByTask,
  type ExperienceQueryOptions,
} from "@cognitive-memory/graph-store";

/**
 * `queryByNode` — hydrate the memories bound to one structural node id — was
 * the pre-M11 read path and retired with the graph at M15 (spec.md §24.2.1:
 * knowledge retrieval must not need to know *where* before it can answer
 * *why*). `queryByMeaning` is the retrieval entry point; this is the exact-task
 * lookup that remains.
 *
 * `options` is forwarded rather than swallowed: §18's `includeCold` and
 * §24.6's `includeSuperseded` are both caller policy, and an episodic API that
 * dropped them would make cold and retracted memories unreachable through the
 * package that owns episodic memory — the one place an explicit "search the
 * full history" request is supposed to be expressible.
 */
export async function queryByTask(
  task: string,
  options: ExperienceQueryOptions = {}
): Promise<Experience[]> {
  return queryExperiencesByTask(task, options);
}
