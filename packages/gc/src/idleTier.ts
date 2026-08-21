/**
 * spec.md §24.5's retention signal, feeding §18's batch job — as a REPORT,
 * not as an action.
 *
 * ## Why this does not mark anything cold
 *
 * The obvious implementation of "an unaccessed short-term memory becomes a
 * §18 GC candidate" is to call `markExperienceCold` on it. That is wrong here,
 * and the reason is worth stating at length because the code is one line away
 * from being wrong:
 *
 * `cold` is not a soft label. It is a hard `AND NOT cold` predicate on every
 * by-meaning retrieval leg (`graph-store/src/experiences.ts`), applied by
 * default (`includeCold: false`). So marking a memory cold removes it from
 * retrieval outright — which is exactly what §24.5 forbids: "by-meaning search
 * always spans all tiers ... Retrieval must never miss a correct cold memory
 * outright — it may only rank it lower."
 *
 * Before M16, every `cold` memory had already had its lessons promoted to a
 * durable semantic edge (`coldStorage.ts`, removed with the structural graph
 * in M15), so the knowledge survived somewhere retrievable and hiding the raw
 * memory lost nothing. An *idle* memory has no such durable representation —
 * and since M15 nothing has a durable representation, which makes this the
 * only retention signal §18 has left. Marking it cold would delete
 * knowledge from the system's reachable surface on the evidence that nobody
 * happened to retrieve it — and since a cold memory cannot be retrieved, it
 * can never accrue an access, so it could never earn its way back. There is no
 * un-cold path anywhere in the tree. It is an absorbing state.
 *
 * That combination (unrecoverable + no durable copy + triggered by mere
 * silence) is how a memory layer quietly loses the half that pays. So M16
 * ships the signal and stops there: §18 learns which memories look retired,
 * and the policy for acting on it needs a durable-representation check that is
 * not this milestone's to decide.
 */
import { listIdleShortTermExperienceIds } from "@cognitive-memory/graph-store";
import { DEFAULT_TIER_THRESHOLDS, type TierThresholds } from "@cognitive-memory/tiers";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Short-term memories with no retrieval inside their idle window.
 *
 * `now` is a parameter for the same reason `runGC`'s is: the retention
 * boundary has to be computable from the same clock the test's backdated
 * fixtures were written against.
 */
export async function listIdleShortTermCandidates(
  now: Date = new Date(),
  thresholds: TierThresholds = DEFAULT_TIER_THRESHOLDS
): Promise<string[]> {
  const cutoff = new Date(now.getTime() - thresholds.idleDays.short * MS_PER_DAY);
  return listIdleShortTermExperienceIds(cutoff);
}
