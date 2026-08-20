/**
 * Tier policy: the pure half of spec.md §24.5.
 *
 * Nothing here touches a database. The whole transition table is one function
 * over one struct, so the full matrix — promote, hold, decay, reject — is
 * unit-testable without Postgres, the same way `packages/semantic`'s
 * confidence maths is separable from its edge writes.
 *
 * ## The open problem, and what M16 decided
 *
 * §24.5 shipped with an explicit hole: *access is not correctness*. A
 * plausible-but-wrong memory that keeps getting retrieved climbs tiers on raw
 * hit counts, and the tier boost then makes it climb faster — a feedback loop
 * that ends with the memory layer's most confident answers being its wrongest
 * ones. §24.5 listed three candidate signals and refused to pick one without
 * a measurement.
 *
 * M16 picks **task-outcome feedback** (§24.5 candidate 2), because it is the
 * only one of the three whose data source already exists in this system:
 * `.claude/hooks/quality-gate.sh` already records a real pass/FAIL verdict per
 * finished task, bound to the files that task changed. The other two are not
 * rejected on merit — candidate 1 (verification-gated) needs read-repair,
 * which is M13 and not built; candidate 3 (used-vs-ignored) needs the agent to
 * cite what it relied on, which nothing in the harness emits today. Both are
 * supported by the same `experience_accesses` join and can be switched on
 * without a schema change: candidate 3 is already implemented as
 * `settleSession`'s optional `usedExperienceIds`, and candidate 1 becomes one
 * more reason to settle an access `rejected`. See `spec.md` §24.5 for the
 * measured justification.
 *
 * What that buys, concretely: `promotionCredit` — a count of *confirmed
 * distinct sessions* — is the only counter the promotion rules read. A memory
 * retrieved fifty times by sessions that all ended badly has
 * `accessCount = 50` and `promotionCredit = 0`, and stays short-term.
 */
import { MEMORY_TIERS, type MemoryTier } from "@cognitive-memory/core";

/**
 * Numeric thresholds, §7-style (spec.md §7 fixed its promotion numbers the
 * same way: stated, not implied, so two runs promote identically).
 *
 * The values are set from the dogfood replay in `eval/tier-promotion` — see
 * spec.md §24.5 for the distribution that justified each one.
 */
export interface TierThresholds {
  /** Promotion credit needed for short → mid. */
  midPromotionCredit: number;
  /** Further promotion credit needed for mid → long, earned AFTER reaching mid. */
  longPromotionCredit: number;
  /**
   * How far back promotion credit is counted. Credit older than this expires,
   * which is what makes the rule "sustained access" rather than "was useful
   * once, years ago".
   */
  sustainedWindowDays: number;
  /** Idle days that drop a memory one tier (short-term drops to GC candidacy instead). */
  idleDays: Record<MemoryTier, number>;
  /** Rejected sessions since the memory last earned credit that cost it a tier. */
  rejectionsBeforeDemotion: number;
}

export const DEFAULT_TIER_THRESHOLDS: TierThresholds = {
  // One is the right number here and it is not a placeholder: the unit is a
  // *confirmed distinct session other than the writer's*, which is already
  // "someone else's task went well while relying on this". Requiring two
  // would mean a memory that has demonstrably helped a different session is
  // still ranked exactly like one nobody has ever read.
  midPromotionCredit: 1,
  // Two more after that, so long-term costs three distinct confirmed sessions
  // in total. Set from the dogfood replay: confirmed sessions per memory is a
  // long tail, and 3 is where long-term stays a small minority of the corpus
  // instead of becoming the default tier. See spec.md §24.5.
  longPromotionCredit: 2,
  sustainedWindowDays: 90,
  idleDays: {
    // Short-term is the tier a memory is born into, so its window is the one
    // that decides how long an unread memory stays in the hot path at all.
    short: 30,
    mid: 90,
    long: 180,
  },
  rejectionsBeforeDemotion: 3,
};

/** What a decision read and what it decided — logged, asserted on, and reported by the eval. */
export type TierReason =
  | "unchanged"
  | "promoted_distinct_session"
  | "promoted_sustained"
  | "demoted_idle"
  | "demoted_rejected";

export interface TierDecisionInput {
  tier: MemoryTier;
  /**
   * THE promotion counter: confirmed distinct sessions settled since the
   * memory entered its current tier, and inside the sustained-access window.
   * Never the raw hit count — that is the whole of §24.5's open problem.
   *
   * "Since entering the current tier" is load-bearing in two directions.
   * Upwards it makes each tier cost fresh evidence, so long-term is three
   * distinct confirmed sessions rather than one confirmation counted twice.
   * Downwards it stops the oscillation a naive all-time counter produces: a
   * memory demoted for going cold would otherwise be re-promoted on its old
   * credit by the very next maintenance pass, flapping forever between two
   * tiers.
   */
  promotionCredit: number;
  /** Rejected sessions since the memory last earned credit. */
  rejectedSinceCredit: number;
  /** Last retrieval of any outcome — decay is about being unread, not about being wrong. */
  lastAccessed: string | null;
  /** Fallback age for a memory nobody has retrieved yet. */
  createdAt: string;
  tierChangedAt: string;
}

export interface TierDecision {
  tier: MemoryTier;
  changed: boolean;
  reason: TierReason;
  /**
   * spec.md §18 GC candidacy. Only ever true for short-term: mid decays to
   * short and gets a fresh window first, and long-term is never a candidate
   * for coldness alone (§24.5).
   */
  gcCandidate: boolean;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function shift(tier: MemoryTier, by: 1 | -1): MemoryTier {
  const index = MEMORY_TIERS.indexOf(tier);
  const next = MEMORY_TIERS[Math.min(MEMORY_TIERS.length - 1, Math.max(0, index + by))];
  return next ?? tier;
}

function idleDays(input: TierDecisionInput, now: Date): number {
  const reference = input.lastAccessed ?? input.createdAt;
  return (now.getTime() - new Date(reference).getTime()) / MS_PER_DAY;
}

/**
 * The whole §24.5 transition table.
 *
 * Order matters and is deliberate: promotion is evaluated before decay, so a
 * memory that was confirmed today cannot be demoted by an idle window it
 * technically still satisfies at the moment the maintenance pass runs.
 * Rejection-driven demotion is evaluated last, because a rejection that has
 * already been outweighed by a later confirmation should not also cost a tier
 * — `rejectedSinceCredit` is counted from the last confirmation precisely so
 * that "outweighed" is expressible.
 */
export function decideTier(
  input: TierDecisionInput,
  now: Date = new Date(),
  thresholds: TierThresholds = DEFAULT_TIER_THRESHOLDS
): TierDecision {
  const unchanged = (gcCandidate = false): TierDecision => ({
    tier: input.tier,
    changed: false,
    reason: "unchanged",
    gcCandidate,
  });

  if (input.tier === "short" && input.promotionCredit >= thresholds.midPromotionCredit) {
    return { tier: "mid", changed: true, reason: "promoted_distinct_session", gcCandidate: false };
  }

  if (input.tier === "mid" && input.promotionCredit >= thresholds.longPromotionCredit) {
    return { tier: "long", changed: true, reason: "promoted_sustained", gcCandidate: false };
  }

  const idle = idleDays(input, now);
  if (idle > thresholds.idleDays[input.tier]) {
    // Short-term has nowhere lower to fall, so its expired window is what
    // hands §18 a retention signal instead of a tier change.
    if (input.tier === "short") return unchanged(true);
    return { tier: shift(input.tier, -1), changed: true, reason: "demoted_idle", gcCandidate: false };
  }

  if (
    input.rejectedSinceCredit >= thresholds.rejectionsBeforeDemotion &&
    input.tier !== "short"
  ) {
    return {
      tier: shift(input.tier, -1),
      changed: true,
      reason: "demoted_rejected",
      gcCandidate: false,
    };
  }

  return unchanged();
}

/**
 * §24.5: "tier feeds the §11 ranking function as a score multiplier" — a
 * boost, never a filter.
 *
 * The spread is deliberately narrow. `MAX_TIER_BOOST / MIN_TIER_BOOST` is
 * 1.25, so any content-relevance gap wider than 25% survives the boost
 * intact: a cold short-term memory that genuinely answers the question still
 * outranks a long-term memory that nearly doesn't. That is the property
 * §24.5 actually demands ("retrieval must never miss a correct cold memory
 * outright — it may only rank it lower"), and it is what the ranking unit
 * test pins.
 */
export const TIER_BOOST: Readonly<Record<MemoryTier, number>> = {
  short: 1,
  mid: 1.1,
  long: 1.25,
};

/** Largest multiplier any tier can apply — the cap the ranking test asserts against. */
export const MAX_TIER_BOOST = TIER_BOOST.long;

/** Boost for a tier, defaulting to no boost when the caller has no tier (an unmigrated or synthetic hit). */
export function tierBoost(tier: MemoryTier | undefined): number {
  return tier ? TIER_BOOST[tier] : TIER_BOOST.short;
}
