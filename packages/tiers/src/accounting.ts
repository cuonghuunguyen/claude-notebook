/**
 * The stateful half of spec.md §24.5: turn retrievals and task outcomes into
 * tier movements. Policy lives in `./policy.js`; storage lives in
 * `@cognitive-memory/graph-store`. This module is only the wiring between
 * them, which is why it is small enough to read in one go.
 *
 * The lifecycle of one access:
 *
 *   retrieval  ──▶ recordRetrievalAccess   (provisional — promotes nothing)
 *   task ends  ──▶ settleSession           (confirmed / rejected)
 *                    └─▶ applyTierDecisions on the memories it touched
 *   nightly    ──▶ runTierMaintenance      (decay, GC candidacy)
 */
import type { MemoryTier } from "@cognitive-memory/core";
import {
  applyTierChanges,
  listTierStates,
  recordExperienceAccesses,
  settleSessionAccesses,
  type TierState,
} from "@cognitive-memory/graph-store";
import {
  decideTier,
  DEFAULT_TIER_THRESHOLDS,
  type TierDecision,
  type TierThresholds,
} from "./policy.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Rows per page in the full-corpus maintenance scan. Large enough that a
 * realistic corpus is one or two round trips, small enough that the pass never
 * holds an unbounded result set in memory.
 */
const MAINTENANCE_PAGE_SIZE = 5000;

export interface TierRunOptions {
  now?: Date;
  thresholds?: TierThresholds;
  /**
   * Rows per page in the full-corpus maintenance scan. Defaults to
   * `MAINTENANCE_PAGE_SIZE`; exposed so a test can force multi-page behaviour
   * without inserting five thousand rows to reach it.
   */
  pageSize?: number;
}

/**
 * Write-on-read accounting for one retrieval (§24.5's first bullet).
 *
 * Best-effort by contract: a failure here is swallowed and reported as `0`,
 * never thrown. Retrieval is a read path, and a memory system that fails a
 * user's question because it could not write a usage statistic has its
 * priorities backwards. The cost of a lost access is one missed increment
 * toward a promotion, which the next retrieval recovers.
 */
export async function recordRetrievalAccess(
  experienceIds: string[],
  sessionId: string,
  options: TierRunOptions = {}
): Promise<number> {
  if (experienceIds.length === 0 || !sessionId) return 0;
  try {
    return await recordExperienceAccesses(experienceIds, sessionId, options.now ?? new Date());
  } catch {
    return 0;
  }
}

export interface SettleSessionResult {
  /** Memories whose accounting this settle changed. */
  settled: string[];
  /** Tier changes it caused, in id order. */
  changes: TierChange[];
}

export interface TierChange {
  id: string;
  from: MemoryTier;
  to: MemoryTier;
  reason: TierDecision["reason"];
  /** Credit consumed by this change — becomes the memory's new watermark. */
  creditWatermark: number;
}

export interface SettleSessionOptions extends TierRunOptions {
  /**
   * The memories this session actually relied on (§24.5 candidate 3).
   *
   * REQUIRED for anything to promote. With `outcome: "confirmed"` and no
   * `usedExperienceIds`, every memory the session retrieved settles `unused`
   * (neutral) rather than `confirmed` — a green task is evidence about the
   * task, not about each memory it happened to retrieve. See
   * `settleSessionAccesses` for the full argument.
   */
  usedExperienceIds?: string[];
}

/**
 * Reports how a session's task ended and moves the tiers that changes.
 *
 * This is M16's answer to §24.5's open problem in one call, and it is
 * fail-closed twice over: nothing counts toward a promotion until this runs
 * (an abandoned session leaves its accesses provisional forever), and a
 * passing task only credits the memories the caller explicitly names. The
 * failure mode of "a good memory promotes a week later" is strictly cheaper
 * than "a wrong memory promotes because nobody said otherwise".
 */
export async function settleSession(
  sessionId: string,
  outcome: "confirmed" | "rejected",
  options: SettleSessionOptions = {}
): Promise<SettleSessionResult> {
  const now = options.now ?? new Date();
  const settled = await settleSessionAccesses(sessionId, outcome, {
    usedExperienceIds: options.usedExperienceIds,
    now,
  });
  if (settled.length === 0) return { settled, changes: [] };
  const changes = await applyTierDecisions({ ids: settled, now, thresholds: options.thresholds });
  return { settled, changes };
}

export interface ApplyTierDecisionsOptions extends TierRunOptions {
  /** Restrict the pass to these memories. Omit for a full-corpus scan. */
  ids?: string[];
}

/**
 * Runs the policy over a set of memories and writes back what it decided.
 *
 * One promotion step per pass, deliberately: `decideTier` returns the *next*
 * tier, not the terminal one, so a memory with enough confirmed sessions for
 * long-term still visits mid-term first. That keeps the transition table
 * total (every state has exactly one successor) and keeps the audit trail
 * honest — `tier_changed_at` records when it actually reached each tier
 * rather than collapsing two promotions into one timestamp.
 */
export async function applyTierDecisions(
  options: ApplyTierDecisionsOptions = {}
): Promise<TierChange[]> {
  const now = options.now ?? new Date();
  const thresholds = options.thresholds ?? DEFAULT_TIER_THRESHOLDS;
  const windowStart = new Date(now.getTime() - thresholds.sustainedWindowDays * MS_PER_DAY);
  const states = await listTierStates({ ids: options.ids, windowStart });

  const changes: TierChange[] = [];
  for (const state of states) {
    const decision = decideTier(toDecisionInput(state), now, thresholds);
    if (decision.changed) {
      changes.push({
        id: state.id,
        from: state.tier,
        to: decision.tier,
        reason: decision.reason,
        creditWatermark: state.creditSeq,
      });
    }
  }
  await applyTierChanges(
    changes.map((c) => ({ id: c.id, tier: c.to, creditWatermark: c.creditWatermark })),
    now
  );
  return changes;
}

export interface TierMaintenanceResult {
  changes: TierChange[];
  /** Short-term memories idle past their window — spec.md §18's retention signal. */
  gcCandidates: string[];
}

/**
 * The periodic pass: decay, promotion catch-up, and GC candidacy over the
 * whole corpus. Separate from `settleSession` because decay is driven by the
 * clock, not by an event — nothing happens to a memory nobody retrieves, so
 * nothing would ever trigger its demotion from inside the request path.
 */
export async function runTierMaintenance(
  options: TierRunOptions = {}
): Promise<TierMaintenanceResult> {
  const now = options.now ?? new Date();
  const thresholds = options.thresholds ?? DEFAULT_TIER_THRESHOLDS;
  const windowStart = new Date(now.getTime() - thresholds.sustainedWindowDays * MS_PER_DAY);

  const changes: TierChange[] = [];
  const gcCandidates: string[] = [];

  // Paged by keyset, not scanned in one query: this is the ONE caller that
  // walks the entire corpus, and spec.md §18 is explicit that the experience
  // log grows without bound. A single unbounded SELECT would either hydrate an
  // arbitrarily large result set into memory or — with `listTierStates`'
  // default cap — silently stop decaying everything past the first page,
  // which is the worse of the two because nothing would report it.
  const pageSize = options.pageSize ?? MAINTENANCE_PAGE_SIZE;
  let after: string | undefined;
  for (;;) {
    const page = await listTierStates({ windowStart, after, limit: pageSize });
    if (page.length === 0) break;

    const pageChanges: TierChange[] = [];
    for (const state of page) {
      const decision = decideTier(toDecisionInput(state), now, thresholds);
      if (decision.changed) {
        pageChanges.push({
          id: state.id,
          from: state.tier,
          to: decision.tier,
          reason: decision.reason,
          creditWatermark: state.creditSeq,
        });
      }
      if (decision.gcCandidate) gcCandidates.push(state.id);
    }

    // Written per page rather than accumulated to the end, so a failure
    // halfway through a large corpus leaves the pages it already decided
    // committed instead of discarding the whole pass.
    await applyTierChanges(
      pageChanges.map((c) => ({ id: c.id, tier: c.to, creditWatermark: c.creditWatermark })),
      now
    );
    changes.push(...pageChanges);

    // Safe as a cursor because the pass never writes `id`, only `tier` —
    // ordering cannot shift underneath the scan.
    after = page[page.length - 1]?.id;
    if (page.length < pageSize) break;
  }

  return { changes, gcCandidates };
}

/**
 * `createdAt` falls back to `tierChangedAt`, which for a never-promoted
 * memory is its capture time (the column defaults to `now()` at insert) —
 * so a freshly captured, never-retrieved memory is not instantly idle.
 */
function toDecisionInput(state: TierState) {
  return {
    tier: state.tier,
    promotionCredit: state.promotionCredit,
    rejectedSinceCredit: state.rejectedSinceCredit,
    lastAccessed: state.lastAccessed,
    createdAt: state.tierChangedAt,
    tierChangedAt: state.tierChangedAt,
  };
}
