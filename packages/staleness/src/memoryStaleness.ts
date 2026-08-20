/**
 * Commit-triggered staleness for knowledge (spec.md §24.2.3 / ROADMAP.md M12).
 *
 * Two entry points for the same question — "has the code this memory describes
 * moved on since the memory was written?" — asked at the two moments it matters:
 *
 *  - `markSuspectFromHistory` at **sync** time, persisting the verdict so it
 *    survives across sessions and so a reader without a checkout still sees it.
 *  - `flagPossiblyStale` at **read** time, from one git lookup, catching commits
 *    made since the last sync (including uncommitted-to-the-DB local work).
 *
 * Neither drops anything. §24.2.3 is explicit, and it is a measured position
 * rather than a courtesy: `WHY_MEMORY_SPIKE.md` showed missing context costing
 * real agent turns, so a memory that *might* be out of date is still worth more
 * than no memory. The flag is the compromise — the agent is told to verify, and
 * decides for itself.
 *
 * What this deliberately does NOT do is decide whether the memory is actually
 * wrong. A file-level trigger cannot: a commit touching `parse.ts` may have
 * changed a comment. Answering that needs to re-read the code against the
 * memory's claim, which is M13's read-repair — and M13 is where the flag gets
 * *cleared* or superseded. M12's job is only to raise it, cheaply and without a
 * parser.
 */
import {
  changedPathUniverse,
  isPossiblyStale,
  matchAnchors,
  newestChangeDate,
  suspectReason,
  type Anchor,
  type ChangedPath,
  type Experience,
} from "@cognitive-memory/core";
import {
  listExperiencesByAnchorPaths,
  markExperiencesSuspect,
} from "@cognitive-memory/graph-store";
import { changedPathsSince } from "./gitChanges.js";

/** A memory plus this pass's verdict on it. */
export interface StalenessVerdict {
  experience: Experience;
  /** True when a commit newer than the memory touched one of its anchored paths. */
  possiblyStale: boolean;
  /** Which change triggered it, e.g. `modified src/parse.ts in a1b2c3d4`. Undefined when fresh. */
  reason?: string;
  /** Author date of the newest matching commit. Undefined when nothing matched. */
  lastCommitDate?: string;
  /** The matching changes, for callers that want to show or re-check them. */
  changes: ChangedPath[];
}

/** Anchors to check for one memory, with the pre-M12 fallback applied by storage. */
function anchorsOf(experience: Experience): Anchor[] {
  return experience.anchors ?? [];
}

export interface FlagPossiblyStaleOptions {
  /** Absolute path to a git work tree for the repo these memories describe. */
  repoDir: string;
  /** Max commits walked. Default 1000 (`changedPathsSince`'s own default). */
  limit?: number;
  /**
   * Ignore commits authored before this instant. Filtered in memory on the
   * author date (`changedPathsSince` explains why not via `git log --since`).
   *
   * Not defaulted from the batch's oldest memory even though that looks free:
   * the walk is bounded by `limit`, so a date bound buys nothing here, and
   * every past version of this code that derived one introduced a silent miss.
   */
  since?: string;
  /**
   * Pre-fetched changes, to reuse one git walk across several calls. When given,
   * no git process is spawned at all — which is how `runPipeline` keeps
   * "one git lookup" true across both of its memory sources.
   */
  changes?: readonly ChangedPath[];
}

/**
 * spec.md §24.2.3's read-time check over a batch of retrieved memories.
 *
 * ONE git invocation for the whole batch, whatever its size, matched in memory
 * against every memory's anchors. A per-memory implementation would spawn a git
 * process per hit on the hot retrieval path.
 *
 * The walk is bounded by commit COUNT (`limit`), never by a git date option,
 * and that is a correctness decision rather than a preference — see
 * `changedPathsSince`'s `since` note for the two silent-miss bugs a
 * `git log --since` bound introduces (wrong clock, and early traversal cutoff).
 * A false flag only costs a verification the agent could skip; a missed flag
 * costs silent trust in stale knowledge, so the cheap bound must be the one that
 * cannot be subtly wrong.
 *
 * A memory already carrying a persisted `suspect` flag stays stale in the
 * verdict even when this pass's own window finds nothing newer — the sync pass
 * may have seen history this walk's `limit` excludes, and reporting
 * `possiblyStale: false` for a memory that `buildContext` will still render as
 * flagged would make the two disagree.
 *
 * Returns verdicts in the input order, and returns one for every input,
 * including memories with no anchors at all (verdict: not stale). Callers rely
 * on the 1:1 correspondence to zip results back together, and silently dropping
 * unanchored memories here would be exactly the "silently dropped" behaviour
 * §24.2.3 forbids.
 */
export async function flagPossiblyStale(
  experiences: readonly Experience[],
  options: FlagPossiblyStaleOptions
): Promise<StalenessVerdict[]> {
  if (experiences.length === 0) return [];

  const changes =
    options.changes ??
    (await changedPathsSince({
      repoDir: options.repoDir,
      since: options.since,
      limit: options.limit,
    }));

  return experiences.map((experience) => {
    const anchors = anchorsOf(experience);
    // `matchAnchors` builds the rename map from the whole change list, so an
    // anchor is followed through renames that happened inside the window.
    const matched = matchAnchors(anchors, changes);
    const newerThanMemory = matched.filter((change) =>
      isPossiblyStale(experience.timestamp, change.date)
    );
    const lastCommitDate = newestChangeDate(newerThanMemory);
    const foundHere = newerThanMemory.length > 0;
    // Either source counts. `experience.suspect` is a persisted verdict from a
    // sync pass that may have walked further back than `limit` allows here.
    const possiblyStale = foundHere || experience.suspect === true;
    const reason = foundHere ? suspectReason(newerThanMemory) : experience.suspectReason;
    return {
      experience: possiblyStale
        ? { ...experience, suspect: true, suspectReason: reason }
        : experience,
      possiblyStale,
      reason: possiblyStale ? reason : undefined,
      lastCommitDate,
      changes: newerThanMemory,
    };
  });
}

export interface MarkSuspectOptions {
  /** Absolute path to a git work tree for the repo the memories describe. */
  repoDir: string;
  /**
   * Only consider commits authored at or after this instant. Omitted ⇒ no date
   * bound, which is the right default for a sync pass: the window has to
   * contain a rename for that rename to be followed (see `changedPathUniverse`),
   * and a "since last sync" window routinely would not.
   */
  since?: string;
  /**
   * Max commits walked. Default 1000.
   *
   * This is the real bound on "the whole history", and it is worth being blunt
   * about: on a repository with more commits than this, renames and edits older
   * than the cap are invisible to the pass, so a memory anchored across such a
   * rename is not flagged. No error is raised — raise `limit` for a full audit
   * of a long history.
   */
  limit?: number;
  /** Restrict the git walk to these paths. See `changedPathsSince` — incompatible with rename following. */
  paths?: readonly string[];
}

export interface MarkSuspectResult {
  /** Paths touched by the walked commits, including pre-rename names. */
  changedPaths: number;
  /** Memories anchored to any of those paths — the candidate set. */
  candidates: number;
  /** Memories actually flagged: anchored to a changed path AND older than the change. */
  marked: number;
  /** Ids of the flagged memories, for callers that want to report or re-check them. */
  markedIds: string[];
}

/**
 * The sync-time pass: walk the repo's history, find the memories anchored to
 * paths it touched, and persist the suspect flag on the ones the history has
 * overtaken.
 *
 * Two filters, not one: a memory must be anchored to a changed path AND the
 * change must be newer than the memory. The second is what stops a fresh mine
 * from flagging everything it just created — capture writes the commit's own
 * date onto the mined memory, so every mined memory is anchored to a path its
 * own commit touched, and equal timestamps must not count (§24.2.3 is
 * strictly-newer).
 *
 * What the two filters do NOT give you is a *precise* flag, and this is worth
 * stating plainly because the first real measurement is unflattering. Dogfooded
 * on this repository (`node scripts/self-memory.mjs sync`): 27 mined memories,
 * 223 changed paths, **24 of 27 flagged**. The cause is not this function — it
 * is that capture anchors a mined memory to *every* file its commit touched,
 * which here includes `ROADMAP.md`, `CLAUDE.md`, `CHAIN_LOG.md` and
 * `BENCHMARKS.md`, files almost every later commit also touches. A memory about
 * a design decision is therefore anchored to the churniest files in the repo
 * and is stale within a commit or two.
 *
 * That rate makes the flag close to uninformative on this corpus, and no
 * heuristic is applied here to improve it, deliberately: narrowing which paths
 * a memory anchors to is a change to capture's semantics (M11) and needs a
 * measurement to justify, not a guess. Recorded as the concrete input to M13,
 * which is the milestone that *resolves* flags at read time rather than merely
 * raising them — a high raise rate is the load M13 is designed to absorb, and
 * §24.2.3 already says repair belongs there.
 *
 * Two round trips to storage, not one per memory: one anchor-path lookup for
 * the candidate set, one batched update for the verdicts.
 */
export async function markSuspectFromHistory(
  options: MarkSuspectOptions
): Promise<MarkSuspectResult> {
  const changes = await changedPathsSince({
    repoDir: options.repoDir,
    since: options.since,
    limit: options.limit,
    paths: options.paths,
  });
  const paths = changedPathUniverse(changes);
  if (paths.length === 0) {
    return { changedPaths: 0, candidates: 0, marked: 0, markedIds: [] };
  }

  const candidates = await listExperiencesByAnchorPaths(paths);
  // Reuse the walk rather than re-running git per candidate — same "one git
  // lookup" property as the read path, and the same rename map for all of them.
  const verdicts = await flagPossiblyStale(candidates, {
    repoDir: options.repoDir,
    changes,
  });

  const stale = verdicts.filter((v) => v.possiblyStale);
  const marked = await markExperiencesSuspect(
    stale.map((v) => ({ id: v.experience.id, reason: v.reason ?? "" }))
  );

  return {
    changedPaths: paths.length,
    candidates: candidates.length,
    marked,
    markedIds: stale.map((v) => v.experience.id),
  };
}
