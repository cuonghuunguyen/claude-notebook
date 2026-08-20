import { randomUUID } from "node:crypto";
import type { Experience } from "@cognitive-memory/core";
import { appendEvent, getPool, recordExperience as storeExperience } from "@cognitive-memory/graph-store";

/**
 * `id`/`timestamp` are generated here rather than required from the caller
 * (matching semantic's `recordObservation`, which mints edge ids itself) —
 * an agent recording what it just observed shouldn't have to invent an
 * identity scheme for it.
 */
export type RecordExperienceInput = Omit<Experience, "id" | "timestamp"> &
  Partial<Pick<Experience, "id" | "timestamp">> & {
    /**
     * The session writing this memory (spec.md §24.5). Recorded so that
     * session's own later retrievals of it are neutral and cannot promote it:
     * a session that writes a memory and reads it back has corroborated
     * nothing. Not part of `Experience` — it describes the write, not the
     * knowledge — which is why it is an input field rather than a §8 field.
     */
    writerSession?: string;
  };

/**
 * Append-only per spec.md §8: this module deliberately exposes no
 * update/delete. To correct an experience, record a new one — the
 * promotion pipeline (packages/semantic) reasons over the full history, not
 * a single "current" record.
 */
export async function recordExperience(input: RecordExperienceInput): Promise<Experience> {
  const { writerSession, ...rest } = input;
  const experience: Experience = {
    ...rest,
    id: input.id ?? randomUUID(),
    timestamp: input.timestamp ?? new Date().toISOString(),
  };

  // Transactional (spec.md §14): the experience write and its
  // ExperienceRecorded event must commit together, or a failure between the
  // two would leave a real experience with no corresponding event —
  // undetectable until a rebuild-from-events replay silently drops it.
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const saved = await storeExperience(experience, client, { writerSession });
    await appendEvent({ eventType: "ExperienceRecorded", payload: { experience: saved } }, client);
    await client.query("COMMIT");
    return saved;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
