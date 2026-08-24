import { randomUUID } from "node:crypto";
import type { Experience } from "@cognitive-memory/core";
import {
  appendEvent,
  recordExperience as storeExperience,
  withTransaction,
  type Queryable,
  type TransactionClient,
} from "@cognitive-memory/graph-store";

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
 * update/delete. To correct an experience, record a new one and link it —
 * `recordSupersedingExperience` (spec.md §24.6 / M13) is the supported path,
 * and retrieval returns chain heads while the superseded text stays queryable.
 * Until M15 the same append-only history was also what `packages/semantic`'s
 * §7 promotion pipeline reasoned over; that pipeline retired with the edges it
 * promoted, and read-repair is where §7/§13's update path lives now.
 */
export async function recordExperience(
  input: RecordExperienceInput,
  /**
   * A caller-managed transaction to join, instead of opening one here.
   *
   * Same pattern (and same reason) as graph-store's `Queryable` parameters:
   * M13's read-repair records a correction and links it to the memory it
   * replaces, and those two writes must land together — a correction without
   * its link is a second competing answer, not a missing detail.
   *
   * Typed as a `TransactionClient` rather than `Queryable` deliberately. Under
   * Postgres that ruled out passing the pool, which would have meant "no BEGIN,
   * possibly two different connections". SQLite has one connection, so the type
   * now rules out the remaining version of the same mistake: passing the shared
   * handle to a parameter that promises the write lands with the caller's, i.e.
   * writing outside the transaction the caller thinks it is in. Only
   * `withTransaction` can mint one.
   *
   * Omitted ⇒ unchanged behaviour: this function owns the transaction.
   */
  db?: TransactionClient
): Promise<Experience> {
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
  const write = async (queryable: Queryable): Promise<Experience> => {
    const saved = await storeExperience(experience, queryable, { writerSession });
    await appendEvent(
      { eventType: "ExperienceRecorded", payload: { experience: saved } },
      queryable
    );
    return saved;
  };

  if (db) return write(db);
  return withTransaction(write);
}
