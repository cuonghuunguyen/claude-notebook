/**
 * spec.md §24.5's open problem, measured.
 *
 * §24.5 shipped with "access is not correctness" explicitly undecided and
 * three candidate signals. M16 had to pick one and justify it with a number,
 * not a preference. This file is that number.
 *
 * What it compares is three promotion rules over one noisy workload — raw
 * retrieval counting, "the task passed" applied to everything retrieved, and
 * "the task passed and reported relying on this memory". The middle arm is the
 * point of the experiment: it is gated, it looks principled, and it is barely
 * better than counting hits. That is what justifies the narrower rule M16
 * ships over the one it nearly shipped.
 *
 * The pure arms need no database (the policy is a pure function over a
 * struct), so the headline comparison runs in CI unconditionally. The last
 * tests need Postgres: they check the shipped `settleSession` path behaves the
 * way the measurement assumes, since otherwise the number would be justifying
 * a design the code does not implement.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeDb,
  getTierState,
  recordExperience,
  useTemporaryDatabase,
} from "@cognitive-memory/graph-store";
import { recordRetrievalAccess, settleSession } from "@cognitive-memory/tiers";
import { buildTraffic } from "./model.js";
import { formatDistribution, replayStrategy, score } from "./strategies.js";

/** A synthetic corpus the size of this repo's real mined history (see report.ts). */
const CORPUS = Array.from({ length: 400 }, (_, i) => `mem-${i}`);

describe("spec.md §24.5 — access is not correctness (M16's measured decision)", () => {
  const traffic = buildTraffic(CORPUS);
  const raw = score(replayStrategy("raw", traffic, CORPUS), traffic);
  const broad = score(replayStrategy("broad", traffic, CORPUS), traffic);
  const narrow = score(replayStrategy("narrow", traffic, CORPUS), traffic);

  it("the workload is actually adversarial, and the outcome signal is genuinely noisy", () => {
    // Guard rails on the fixture itself. If misleading memories were never
    // retrieved twice, or if the outcome signal were a perfect oracle, every
    // arm would score 1.0 and the comparison would measure nothing. The last
    // two assertions are what keep this experiment honest: some sessions that
    // relied on a wrong memory still PASSED, and some clean sessions failed.
    const retrievedMisleading = [...traffic.misleadingIds].filter((id) =>
      traffic.retrievedIds.has(id)
    );
    expect(retrievedMisleading.length).toBeGreaterThan(10);
    expect(traffic.events.length).toBeGreaterThan(400);

    const falseConfirms = traffic.events.filter(
      (e) => e.outcome === "confirmed" && e.reliedOn.some((id) => traffic.misleadingIds.has(id))
    );
    const falseRejects = traffic.events.filter(
      (e) => e.outcome === "rejected" && !e.reliedOn.some((id) => traffic.misleadingIds.has(id))
    );
    expect(falseConfirms.length).toBeGreaterThan(5);
    expect(falseRejects.length).toBeGreaterThan(5);
  });

  it("raw access counting promotes plausible-but-wrong memories — the failure §24.5 predicted", () => {
    expect(raw.misleadingPromoted).toBeGreaterThan(0);
    expect(raw.misleadingLongTerm).toBeGreaterThan(0);
    expect(raw.longTermPrecision).toBeLessThan(1);
  });

  it("gating on the task outcome ALONE is barely an improvement — the trap M16 avoided", () => {
    // The finding that changed M16's design. "The task passed" is a fact
    // about the task, not about each memory it happened to retrieve, and most
    // tasks pass — so crediting everything a green task touched is a rounding
    // error away from counting hits. If this starts failing because `broad`
    // got much better, the workload stopped being realistic.
    expect(broad.misleadingPromoted).toBeGreaterThan(0);
    expect(broad.longTermPrecision).toBeLessThan(1);
    expect(broad.promotedPrecision - raw.promotedPrecision).toBeLessThan(0.1);
  });

  it("gating on REPORTED USE is materially better than either", () => {
    // The shipped rule. Deliberately NOT asserted to be perfect — it cannot
    // be, because a wrong memory relied on while the tests stay green does
    // earn credit. The claim is a large, measured reduction, not elimination.
    expect(narrow.promotedPrecision).toBeGreaterThan(broad.promotedPrecision);
    expect(narrow.misleadingPromoted).toBeLessThan(broad.misleadingPromoted / 2);
    expect(narrow.misleadingLongTerm).toBeLessThanOrEqual(raw.misleadingLongTerm);
  });

  it("the shipped rule still promotes a real population of sound memories", () => {
    // The cheap way to win on precision is to promote nothing.
    expect(narrow.soundPromoted).toBeGreaterThan(50);
  });

  it("long-term stays a minority of the corpus at the shipped thresholds", () => {
    expect(narrow.distribution.long / CORPUS.length).toBeLessThan(0.35);
    expect(narrow.distribution.short / CORPUS.length).toBeGreaterThan(0.4);
  });

  it("reports the measurement (the numbers quoted in spec.md §24.5)", () => {
    const row = (label: string, r: typeof raw) =>
      `${label.padEnd(7)}: ${formatDistribution(r.distribution)} | boosted precision ${r.promotedPrecision.toFixed(3)} | wrong-in-boosted ${r.misleadingPromoted} | wrong-in-long ${r.misleadingLongTerm} | sound-boosted ${r.soundPromoted}`;
    const lines = [
      `corpus=${CORPUS.length} events=${traffic.events.length} misleading=${traffic.misleadingIds.size} retrieved=${traffic.retrievedIds.size}`,
      row("raw", raw),
      row("broad", broad),
      row("narrow", narrow),
    ];
    // eslint-disable-next-line no-console
    console.log(lines.join("\n"));
    expect(lines).toHaveLength(4);
  });
});


describe("§24.5 — the shipped path agrees with the simulator", () => {
  beforeAll(async () => {
    await useTemporaryDatabase();
  });
  afterAll(async () => {
    await closeDb();
  });

  it("three confirmed distinct sessions walk a real memory short → mid → long", async () => {
    const id = `tier-eval-${randomUUID()}`;
    await recordExperience({
      id,
      task: `tier eval ${id}`,
      observation: `eval memory ${id} for spec.md §24.5`,
      lessons: [],
      relatedNodes: [],
      confidence: 0.7,
      timestamp: new Date().toISOString(),
    });

    const walk: string[] = [];
    for (let i = 0; i < 3; i++) {
      const sessionId = `${id}-session-${i}`;
      await recordRetrievalAccess([id], sessionId);
      await settleSession(sessionId, "confirmed", { usedExperienceIds: [id] });
      walk.push((await getTierState(id))?.tier ?? "missing");
    }

    // Exactly the trajectory `replayStrategy` produces for credit 1,2,3 — one
    // promotion step per settle, mid before long.
    expect(walk).toEqual(["mid", "mid", "long"]);
  });

  it("no volume of rejected sessions promotes a real memory", async () => {
    const id = `tier-eval-${randomUUID()}`;
    await recordExperience({
      id,
      task: `tier eval ${id}`,
      observation: `eval memory ${id} for spec.md §24.5 rejected arm`,
      lessons: [],
      relatedNodes: [],
      confidence: 0.7,
      timestamp: new Date().toISOString(),
    });

    for (let i = 0; i < 10; i++) {
      const sessionId = `${id}-bad-session-${i}`;
      await recordRetrievalAccess([id], sessionId);
      await settleSession(sessionId, "rejected");
    }

    const state = await getTierState(id);
    // Ten distinct sessions — a raw distinct-session counter would have put
    // this in long-term twice over.
    expect(state?.tier).toBe("short");
    expect(state?.accessCount).toBe(10);
    expect(state?.promotionCredit).toBe(0);
  });
});
