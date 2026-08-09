import { randomUUID } from "node:crypto";
import type { Experience } from "@cognitive-memory/core";
import { recordExperience as storeExperience } from "@cognitive-memory/graph-store";

/**
 * `id`/`timestamp` are generated here rather than required from the caller
 * (matching semantic's `recordObservation`, which mints edge ids itself) —
 * an agent recording what it just observed shouldn't have to invent an
 * identity scheme for it.
 */
export type RecordExperienceInput = Omit<Experience, "id" | "timestamp"> &
  Partial<Pick<Experience, "id" | "timestamp">>;

/**
 * Append-only per spec.md §8: this module deliberately exposes no
 * update/delete. To correct an experience, record a new one — the
 * promotion pipeline (packages/semantic) reasons over the full history, not
 * a single "current" record.
 */
export async function recordExperience(input: RecordExperienceInput): Promise<Experience> {
  const experience: Experience = {
    ...input,
    id: input.id ?? randomUUID(),
    timestamp: input.timestamp ?? new Date().toISOString(),
  };
  return storeExperience(experience);
}
