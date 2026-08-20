import type { Experience } from "@cognitive-memory/core";
import {
  queryExperiencesByNode,
  queryExperiencesByTask,
  type ExperienceQueryOptions,
} from "@cognitive-memory/graph-store";

/**
 * `options` is forwarded rather than swallowed: §18's `includeCold` and
 * §24.6's `includeSuperseded` are both caller policy, and an episodic API that
 * dropped them would make cold and retracted memories unreachable through the
 * package that owns episodic memory — the one place an explicit "search the
 * full history" request is supposed to be expressible.
 */
export async function queryByNode(
  nodeId: string,
  options: ExperienceQueryOptions = {}
): Promise<Experience[]> {
  return queryExperiencesByNode(nodeId, options);
}

export async function queryByTask(
  task: string,
  options: ExperienceQueryOptions = {}
): Promise<Experience[]> {
  return queryExperiencesByTask(task, options);
}
