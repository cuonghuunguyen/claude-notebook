/**
 * The actual experiment behind spec.md §24.5's decision.
 *
 * THREE promotion rules run over the SAME workload, through the SAME policy
 * function (`decideTier`) with the SAME thresholds. The only thing that varies
 * is which accesses feed `promotionCredit`:
 *
 *   raw    — every distinct session that RETRIEVED the memory. The strawman
 *            §24.5 warned about, and what a naive
 *            "access_count/distinct_sessions" implementation ships.
 *   broad  — every distinct session that retrieved it AND whose task passed.
 *            The obvious reading of "task-outcome feedback", and the one M16
 *            nearly shipped. Included precisely because it LOOKS gated: it is
 *            the arm that shows why "gated" is not automatically "gated on
 *            something informative".
 *   narrow — sessions whose task passed AND that reported relying on this
 *            memory. What M16 actually ships.
 *
 * Holding everything else fixed is what makes this a justification rather than
 * an anecdote. The middle arm is the load-bearing one: without it, the
 * experiment would only show that gating beats not gating, which was never in
 * doubt, instead of showing which gate is worth having.
 */
import { MEMORY_TIERS, type MemoryTier } from "@cognitive-memory/core";
import { decideTier, DEFAULT_TIER_THRESHOLDS, type TierThresholds } from "@cognitive-memory/tiers";
import type { SessionEvent, TrafficModel } from "./model.js";

export type Strategy = "raw" | "broad" | "narrow";

export interface StrategyResult {
  strategy: Strategy;
  tiers: Map<string, MemoryTier>;
  distribution: Record<MemoryTier, number>;
  /** Confirmed-distinct-session counts, for the threshold histogram. */
  creditHistogram: Map<number, number>;
}

interface Accumulator {
  tier: MemoryTier;
  /** Distinct sessions counted toward promotion since entering the current tier. */
  creditSessions: Set<string>;
  /** Rejected sessions since the last credit, for the demotion rule. */
  rejectedSinceCredit: Set<string>;
  totalCredit: number;
}

/**
 * Replays the workload one session at a time, in the same ORDER production
 * does: an outcome is reported and that memory's tier is immediately
 * re-decided, one step per settle. Sequencing matters — each tier costs credit
 * earned after the previous one, which a batch count would hide.
 *
 * Two honest caveats about what this simulator is:
 *
 *  - It is a reimplementation of the accounting, not the shipped code. It
 *    models credit consumption by clearing a set; production consumes by
 *    sequence watermark. The two agree on the trajectory (`report.ts` drives
 *    the real path over the same traffic and compares), but this file cannot
 *    validate the shipped SQL and does not claim to.
 *  - `now` is frozen, so the decay branch of `decideTier` never fires: this
 *    measures the PROMOTION signal in isolation. Decay is covered by
 *    `packages/tiers`' own tests, where the clock is moved deliberately.
 */
export function replayStrategy(
  strategy: Strategy,
  traffic: TrafficModel,
  corpusIds: string[],
  thresholds: TierThresholds = DEFAULT_TIER_THRESHOLDS,
  now = new Date("2026-08-19T00:00:00Z")
): StrategyResult {
  const state = new Map<string, Accumulator>();
  const nowIso = now.toISOString();
  for (const id of corpusIds) {
    state.set(id, {
      tier: "short",
      creditSessions: new Set(),
      rejectedSinceCredit: new Set(),
      totalCredit: 0,
    });
  }

  for (const event of traffic.events) {
    // Every memory the session RETRIEVED is a candidate; which of them earns
    // credit is the strategy's decision, made in `creditsFor`.
    for (const id of new Set(event.retrieved)) {
      const acc = state.get(id);
      if (!acc) continue;
      applyEvent(strategy, acc, event, id, thresholds, nowIso, now);
    }
  }

  const tiers = new Map<string, MemoryTier>();
  const distribution: Record<MemoryTier, number> = { short: 0, mid: 0, long: 0 };
  const creditHistogram = new Map<number, number>();
  for (const [id, acc] of state) {
    tiers.set(id, acc.tier);
    distribution[acc.tier]++;
    creditHistogram.set(acc.totalCredit, (creditHistogram.get(acc.totalCredit) ?? 0) + 1);
  }
  return { strategy, tiers, distribution, creditHistogram };
}

/**
 * Whether this (session, memory) access earns promotion credit under one rule.
 *
 * This function IS the experiment's independent variable.
 */
function credits(strategy: Strategy, event: SessionEvent, id: string): boolean {
  switch (strategy) {
    case "raw":
      // Retrieval alone. Outcome ignored entirely.
      return true;
    case "broad":
      // The task passed. Says nothing about whether THIS memory helped.
      return event.outcome === "confirmed";
    case "narrow":
      // The task passed AND the session reported relying on this memory.
      return event.outcome === "confirmed" && event.reliedOn.includes(id);
  }
}

function applyEvent(
  strategy: Strategy,
  acc: Accumulator,
  event: SessionEvent,
  id: string,
  thresholds: TierThresholds,
  nowIso: string,
  now: Date
): void {
  const counts = credits(strategy, event, id);
  // A rejection is a rejection under every gated rule: a failing task
  // withholds credit from everything it retrieved. Held identical across arms
  // so the only thing that varies is what EARNS credit.
  const rejected = strategy !== "raw" && event.outcome === "rejected";

  if (counts) {
    acc.creditSessions.add(event.sessionId);
    acc.rejectedSinceCredit.clear();
    acc.totalCredit++;
  } else if (rejected) {
    acc.rejectedSinceCredit.add(event.sessionId);
  }

  const decision = decideTier(
    {
      tier: acc.tier,
      promotionCredit: acc.creditSessions.size,
      rejectedSinceCredit: acc.rejectedSinceCredit.size,
      lastAccessed: nowIso,
      createdAt: nowIso,
      tierChangedAt: nowIso,
    },
    now,
    thresholds
  );

  if (!decision.changed) return;
  acc.tier = decision.tier;
  // Credit is counted from `tier_changed_at` in production; resetting the set
  // here is the in-memory equivalent. Without it, one confirmation would be
  // counted again by the next tier and long-term would cost less evidence
  // than the thresholds claim.
  acc.creditSessions.clear();
  acc.rejectedSinceCredit.clear();
}

export interface PrecisionReport {
  strategy: Strategy;
  distribution: Record<MemoryTier, number>;
  /** Share of promoted (mid+long) memories that are actually sound. */
  promotedPrecision: number;
  /** Share of long-term memories that are actually sound. */
  longTermPrecision: number;
  /** Misleading memories that nonetheless climbed out of short-term. */
  misleadingPromoted: number;
  /** Misleading memories that reached the top tier. */
  misleadingLongTerm: number;
  /** Sound, retrieved memories that reached mid or long — the signal's recall. */
  soundPromoted: number;
}

/**
 * Scores one arm against ground truth.
 *
 * Precision, not accuracy: the cost §24.5 cares about is asymmetric. A sound
 * memory left in short-term is merely ranked lower (tier is a boost, never a
 * gate), while a wrong memory in long-term is actively promoted into every
 * future answer. So the metric that decides the design is "of the memories we
 * boosted, how many deserved it".
 */
export function score(result: StrategyResult, traffic: TrafficModel): PrecisionReport {
  let misleadingPromoted = 0;
  let misleadingLongTerm = 0;
  let soundPromoted = 0;
  let promotedTotal = 0;
  let longTotal = 0;
  let longSound = 0;

  for (const [id, tier] of result.tiers) {
    const promoted = tier !== "short";
    const misleading = traffic.misleadingIds.has(id);
    if (promoted) {
      promotedTotal++;
      if (misleading) misleadingPromoted++;
      else soundPromoted++;
    }
    if (tier === "long") {
      longTotal++;
      if (misleading) misleadingLongTerm++;
      else longSound++;
    }
  }

  return {
    strategy: result.strategy,
    distribution: result.distribution,
    promotedPrecision: promotedTotal === 0 ? 1 : soundPromoted / promotedTotal,
    longTermPrecision: longTotal === 0 ? 1 : longSound / longTotal,
    misleadingPromoted,
    misleadingLongTerm,
    soundPromoted,
  };
}

/** Renders a distribution as `short/mid/long` percentages for the report table. */
export function formatDistribution(distribution: Record<MemoryTier, number>): string {
  const total = MEMORY_TIERS.reduce((sum, t) => sum + distribution[t], 0) || 1;
  return MEMORY_TIERS.map(
    (t) => `${t} ${distribution[t]} (${((100 * distribution[t]) / total).toFixed(1)}%)`
  ).join(", ");
}
