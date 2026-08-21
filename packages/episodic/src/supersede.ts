/**
 * Read-repair (spec.md §24.2 decision 4 / §24.6, ROADMAP.md M13).
 *
 * M12 gave a memory a way to be doubted and nothing to do about it: the
 * staleness pass flags a memory whose anchored files a newer commit touched,
 * the flag rides into the agent's context, and there it stops. Dogfooded on
 * this repository that pass flagged 24 of 27 memories (see
 * `markSuspectFromHistory`'s note), which is close to uninformative — a warning
 * that fires on everything is a warning about nothing.
 *
 * This module is the other half: the two answers a reader can give a flagged
 * memory once it has actually looked.
 *
 *   `recordVerification`          — "I checked; it is still true."
 *   `recordSupersedingExperience` — "I checked; here is what is true now."
 *
 * Both are read-time, caller-driven, and neither runs on its own. That is
 * §24.2.3's decision, not an omission: repair happens where staleness is
 * noticed, because that is the only moment something is actually reading the
 * code the memory describes. There is no background rescan to add later.
 *
 * Nothing here deletes. A corrected memory keeps its text and its link to the
 * correction, so "what did we believe, and what changed our mind" stays
 * answerable (`memoryHistory`) — which is the question the corrected memory,
 * on its own, cannot answer.
 */
import type { Experience } from "@cognitive-memory/core";
import {
  appendEvent,
  getExperienceById,
  getPool,
  getSupersedeHead,
  listSupersedeChain,
  markExperienceVerified,
  supersedeExperience,
} from "@cognitive-memory/graph-store";
import { recordExperience, type RecordExperienceInput } from "./record.js";

export type RecordSupersedingInput = Omit<RecordExperienceInput, "relatedNodes"> & {
  /**
   * The correction's `relatedNodes` — the text mirror of its anchors. Named
   * for the structural node ids it carried until M15; nothing produces one now.
   *
   * Optional here where `recordExperience` requires it, so that "the caller did
   * not say" is distinguishable from "the caller said none" — the first
   * inherits from the superseded memory, the second is respected. Making it
   * required would collapse those into one value and force the inherit-on-empty
   * rule, which silently binds a correction to the OLD memory's symbols even
   * when the caller explicitly re-anchored it somewhere else.
   */
  relatedNodes?: string[];
  /** The memory this correction replaces. Must already exist. */
  supersedes: string;
  /**
   * When the check that produced this correction was made. Defaults to now.
   * Recorded on the link, not on either memory.
   */
  supersededAt?: string;
};

export interface SupersedeOutcome {
  /** The correction, as recorded. This is what retrieval will return from now on. */
  experience: Experience;
  /** The memory it replaced, as it looked before the link was made. */
  superseded: Experience;
}

/**
 * Record a correction and retire the memory it corrects, atomically.
 *
 * Atomicity matters more here than it looks. The two halves fail differently:
 * a correction written without its link is a *second* answer competing with the
 * memory it was meant to replace (both are heads, both are retrieved, and the
 * reader now has two contradictory memories with no way to tell which won),
 * while a link written without its correction is impossible. So the failure
 * mode of doing this in two calls is not "a missing link" but "the graph now
 * contradicts itself", which is exactly the state §13's conflict resolution
 * exists to prevent. One transaction, one connection.
 *
 * Anchors and `relatedNodes` are inherited from the superseded memory when the
 * caller omits them. A correction is by definition about the same code, and a
 * correction that lost its anchors would be invisible to the very staleness
 * pass that surfaced its predecessor — it would be born unfalsifiable. Both
 * fields follow the same rule: `undefined` inherits, an explicit `[]` is
 * respected. That symmetry is why `relatedNodes` is optional on this input and
 * required on `RecordExperienceInput`.
 */
export async function recordSupersedingExperience(
  input: RecordSupersedingInput
): Promise<SupersedeOutcome> {
  const { supersedes, supersededAt, ...rest } = input;

  const previous = await getExperienceById(supersedes);
  if (!previous) {
    throw new Error(`recordSupersedingExperience: no such experience to supersede: ${supersedes}`);
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const experience = await recordExperience(
      {
        ...rest,
        relatedNodes: rest.relatedNodes ?? previous.relatedNodes,
        anchors: rest.anchors ?? previous.anchors,
      },
      client
    );
    const link = await supersedeExperience(previous.id, experience.id, {
      supersededAt,
      db: client,
    });
    await appendEvent(
      {
        eventType: "ExperienceSuperseded",
        payload: { oldId: previous.id, newId: experience.id, supersededAt: link.supersededAt },
      },
      client
    );
    await client.query("COMMIT");
    return { experience, superseded: previous };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Read-repair's other outcome: the memory was checked and is still accurate.
 *
 * Clears M12's suspect mark and stamps the instant of the check, which is what
 * stops the read-time staleness test from re-deriving the same verdict from the
 * same commit on the very next query. See `markExperienceVerified`.
 *
 * Returns false for an unknown id rather than throwing — a caller repairing a
 * batch should be able to report "that one is gone" without aborting the batch.
 */
export async function recordVerification(
  id: string,
  verifiedAt?: string
): Promise<boolean> {
  return markExperienceVerified(id, verifiedAt);
}

/**
 * The full history of one memory's chain, oldest first, head last.
 *
 * This is the "history remains queryable explicitly" half of §24.2 decision 4.
 * Default retrieval returns only the head; a reader who wants to know what the
 * system used to believe asks for it here, by id, deliberately.
 */
export async function memoryHistory(id: string): Promise<Experience[]> {
  return listSupersedeChain(id);
}

/**
 * The current answer for a remembered id.
 *
 * An id handed out in an earlier context bundle, a scout report or a log line
 * keeps naming the retracted text forever. This resolves it forward to whatever
 * replaced it (or returns the memory itself, if nothing did).
 */
export async function currentMemory(id: string): Promise<Experience | undefined> {
  return getSupersedeHead(id);
}
