import { listIdleShortTermCandidates } from "./idleTier.js";

export interface GCResult {
  /**
   * Short-term memories idle past their §24.5 window — REPORTED ONLY.
   *
   * Deliberately not acted on here. See `idleTier.ts` for why marking these
   * cold would violate §24.5's "retrieval must never miss a correct cold
   * memory outright": `cold` is a hard filter on every by-meaning leg, and an
   * idle memory — unlike a promoted one — has no durable representation
   * elsewhere to be found through. So §18 gets its retention *signal* here,
   * and the decision to actually retire a memory stays out of M16.
   */
  idleShortTermCandidates: number;
}

/**
 * spec.md §18's batch job.
 *
 * ## What M15 took out of it, and why nothing replaced it
 *
 * Until M15 this job did three things: hard-delete soft-deleted structural
 * nodes past a 90-day retention window, hard-delete invalidated edges past a
 * 30-day one, and mark an experience cold once every structural node it was
 * bound to had a durable semantic edge (`coldStorage.ts`). All three retired
 * with the structural graph: two of them collected node and edge rows that no
 * longer exist, and the third was *already* a no-op for every memory captured
 * since M12 — its eligibility test asked whether each entry in `relatedNodes`
 * resolved to a node with a durable edge, and a text anchor never resolves to
 * one, so it skipped them. That is measurable rather than assumed: on this
 * repository's own memory graph, every memory is text-anchored.
 *
 * So §18 stands (spec.md §24.4) with the one signal it has left, which is
 * M16's: memories that no session has usefully accessed inside their tier's
 * idle window. It is reported, not acted on — `idleTier.ts` explains why that
 * is a deliberate stopping point and not an unfinished one.
 *
 * `now` defaults to the real clock but is accepted as a parameter so tests can
 * exercise the idle-window boundary without waiting real days.
 */
export async function runGC(now: Date = new Date()): Promise<GCResult> {
  // Counted, not acted on — see `GCResult.idleShortTermCandidates`.
  const idleShortTermCandidates = (await listIdleShortTermCandidates(now)).length;

  return { idleShortTermCandidates };
}
