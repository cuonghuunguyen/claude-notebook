import type { Experience } from "@cognitive-memory/core";
import {
  queryExperiencesByNode,
  queryExperiencesByTask,
} from "@cognitive-memory/graph-store";

export async function queryByNode(nodeId: string): Promise<Experience[]> {
  return queryExperiencesByNode(nodeId);
}

export async function queryByTask(task: string): Promise<Experience[]> {
  return queryExperiencesByTask(task);
}
