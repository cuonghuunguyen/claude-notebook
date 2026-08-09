import type { Experience } from "@cognitive-memory/core";
import { queryByNode } from "@cognitive-memory/episodic";

/**
 * Fetches prior experiences touching any node in `nodeIds`, deduped by
 * experience id (an experience can list several `relatedNodes`, so the same
 * one can come back from more than one lookup) — this is the DB-touching
 * glue `buildContext` deliberately doesn't do itself (see types.ts's
 * `Subgraph.experiences` doc); callers assemble the subgraph, including its
 * prior experience, before handing it to `buildContext`.
 */
export async function hydrateExperiences(nodeIds: string[]): Promise<Experience[]> {
  const lists = await Promise.all(nodeIds.map((id) => queryByNode(id)));
  const byId = new Map<string, Experience>();
  for (const experience of lists.flat()) {
    byId.set(experience.id, experience);
  }
  return [...byId.values()];
}
