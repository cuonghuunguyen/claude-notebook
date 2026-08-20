import { describe, expect, it } from "vitest";
import {
  decideTier,
  DEFAULT_TIER_THRESHOLDS,
  MAX_TIER_BOOST,
  TIER_BOOST,
  tierBoost,
  type TierDecisionInput,
} from "./policy.js";

const NOW = new Date("2026-08-20T00:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

/** A memory just captured and read once today, by a session that went well. */
function state(overrides: Partial<TierDecisionInput> = {}): TierDecisionInput {
  return {
    tier: "short",
    promotionCredit: 0,
    rejectedSinceCredit: 0,
    lastAccessed: daysAgo(0),
    createdAt: daysAgo(1),
    tierChangedAt: daysAgo(1),
    ...overrides,
  };
}

describe("decideTier — promotion (spec.md §24.5)", () => {
  it("holds a captured memory in short-term until some other session has confirmed it", () => {
    const decision = decideTier(state(), NOW);
    expect(decision).toMatchObject({ tier: "short", changed: false, reason: "unchanged" });
  });

  it("promotes short -> mid on one confirmed distinct session", () => {
    const decision = decideTier(state({ promotionCredit: 1 }), NOW);
    expect(decision).toMatchObject({
      tier: "mid",
      changed: true,
      reason: "promoted_distinct_session",
    });
  });

  it("promotes mid -> long only on sustained access: further confirmed sessions earned AFTER reaching mid-term", () => {
    const enough = state({ tier: "mid", promotionCredit: 2 });
    expect(decideTier(enough, NOW)).toMatchObject({ tier: "long", reason: "promoted_sustained" });

    // One confirmation since reaching mid-term is not "sustained". Credit is
    // counted from the tier change and expires with the window, so a memory
    // that mattered once, long ago, does not keep climbing on it.
    const notYet = state({ tier: "mid", promotionCredit: 1 });
    expect(decideTier(notYet, NOW)).toMatchObject({ tier: "mid", changed: false });
  });

  it("does not re-promote a memory that was just demoted for going cold — credit is counted from the tier change", () => {
    // The oscillation an all-time counter produces: demote for idleness,
    // re-promote on ancient credit, forever. `promotionCredit` resets at the
    // tier change, so a demoted memory has to be found useful again.
    const justDemoted = state({
      tier: "short",
      promotionCredit: 0,
      lastAccessed: daysAgo(DEFAULT_TIER_THRESHOLDS.idleDays.short + 1),
      tierChangedAt: daysAgo(0),
    });
    expect(decideTier(justDemoted, NOW)).toMatchObject({ tier: "short", changed: false });
  });

  it("climbs one tier per pass, so a memory with long-term-worthy usage still visits mid-term", () => {
    const hot = state({ promotionCredit: 9 });
    expect(decideTier(hot, NOW).tier).toBe("mid");
  });

  it("never promotes past long-term", () => {
    const maxed = state({ tier: "long", promotionCredit: 50 });
    expect(decideTier(maxed, NOW)).toMatchObject({ tier: "long", changed: false });
  });
});

describe("decideTier — the usefulness gate (§24.5's open problem: access ≠ correctness)", () => {
  it("does NOT promote on raw retrieval volume: a memory read constantly by sessions that all ended badly stays short-term", () => {
    // This is the failure §24.5 named as unsolved. `accessCount` is not even
    // an input to the decision — the only counter it reads is
    // `promotionCredit` — so a plausible-but-wrong memory cannot climb by
    // being popular. The 40 hits below live on the row (they are recorded
    // write-on-read) and buy nothing.
    const popularButUseless = state({ promotionCredit: 0, rejectedSinceCredit: 12 });
    expect(decideTier(popularButUseless, NOW)).toMatchObject({ tier: "short", changed: false });
  });

  it("treats repeated rejection as a demotion signal, not a neutral one", () => {
    const rejected = state({
      tier: "mid",
      promotionCredit: 0,
      rejectedSinceCredit: DEFAULT_TIER_THRESHOLDS.rejectionsBeforeDemotion,
    });
    expect(decideTier(rejected, NOW)).toMatchObject({
      tier: "short",
      changed: true,
      reason: "demoted_rejected",
    });
  });

  it("lets a later confirmation outweigh earlier rejections", () => {
    // `rejectedSinceCredit` counts only rejections since the memory last
    // earned credit, so a memory that got three things wrong and has since
    // been confirmed is not demoted for its history.
    const redeemed = state({ tier: "mid", promotionCredit: 4, rejectedSinceCredit: 0 });
    expect(decideTier(redeemed, NOW).reason).not.toBe("demoted_rejected");
  });

  it("never demotes short-term on rejections — it is already the floor, and GC is the mechanism there", () => {
    const floored = state({ tier: "short", rejectedSinceCredit: 99 });
    expect(decideTier(floored, NOW)).toMatchObject({ tier: "short", changed: false });
  });
});

describe("decideTier — decay and GC candidacy (§24.5 / §18)", () => {
  it("demotes long -> mid after its idle window", () => {
    const cold = state({
      tier: "long",
      promotionCredit: 0,
      lastAccessed: daysAgo(DEFAULT_TIER_THRESHOLDS.idleDays.long + 1),
    });
    expect(decideTier(cold, NOW)).toMatchObject({
      tier: "mid",
      changed: true,
      reason: "demoted_idle",
      gcCandidate: false,
    });
  });

  it("demotes mid -> short after its (shorter) idle window", () => {
    const cold = state({
      tier: "mid",
      promotionCredit: 0,
      lastAccessed: daysAgo(DEFAULT_TIER_THRESHOLDS.idleDays.mid + 1),
    });
    expect(decideTier(cold, NOW)).toMatchObject({ tier: "short", reason: "demoted_idle" });
  });

  it("makes an idle short-term memory a GC candidate instead of demoting it further", () => {
    const cold = state({
      lastAccessed: daysAgo(DEFAULT_TIER_THRESHOLDS.idleDays.short + 1),
    });
    expect(decideTier(cold, NOW)).toMatchObject({ tier: "short", changed: false, gcCandidate: true });
  });

  it("never makes a long-term memory a GC candidate for coldness alone", () => {
    const ancient = state({ tier: "long", promotionCredit: 0, lastAccessed: daysAgo(10_000) });
    expect(decideTier(ancient, NOW).gcCandidate).toBe(false);
  });

  it("measures idleness from capture time for a memory nobody has ever retrieved", () => {
    const neverRead = state({ lastAccessed: null, createdAt: daysAgo(2), tierChangedAt: daysAgo(2) });
    expect(decideTier(neverRead, NOW).gcCandidate).toBe(false);

    const neverReadAndOld = state({
      lastAccessed: null,
      createdAt: daysAgo(DEFAULT_TIER_THRESHOLDS.idleDays.short + 1),
      tierChangedAt: daysAgo(DEFAULT_TIER_THRESHOLDS.idleDays.short + 1),
    });
    expect(decideTier(neverReadAndOld, NOW).gcCandidate).toBe(true);
  });

  it("prefers a promotion over a decay when both windows are satisfied in the same pass", () => {
    // Confirmed today, but its `lastAccessed` fixture is stale — a
    // maintenance pass must not demote a memory that just earned a promotion.
    const both = state({
      tier: "mid",
      promotionCredit: 2,
      lastAccessed: daysAgo(DEFAULT_TIER_THRESHOLDS.idleDays.mid + 1),
    });
    expect(decideTier(both, NOW).tier).toBe("long");
  });
});

describe("tierBoost — §11 ranking multiplier, never a filter (§24.5)", () => {
  it("orders the boosts short < mid < long", () => {
    expect(TIER_BOOST.short).toBeLessThan(TIER_BOOST.mid);
    expect(TIER_BOOST.mid).toBeLessThan(TIER_BOOST.long);
  });

  it("keeps the whole spread inside a bounded cap, so tier can only reorder near-ties", () => {
    expect(MAX_TIER_BOOST / TIER_BOOST.short).toBeLessThanOrEqual(1.25);
  });

  it("treats a tierless hit as short-term rather than throwing", () => {
    expect(tierBoost(undefined)).toBe(TIER_BOOST.short);
  });
});
