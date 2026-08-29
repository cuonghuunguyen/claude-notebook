import { describe, expect, it } from "vitest";
import type { Experience, MemoryTier } from "@cognitive-memory/core";
import type { ExperienceSearchHit } from "@cognitive-memory/graph-store";
import { TIER_BOOST } from "@cognitive-memory/tiers";
import { DEFAULT_LEG_WEIGHTS, fuseLegs, lengthPrior, LENGTH_PRIOR_FREE_CHARS, toExperienceTsQuery, type MeaningLeg } from "./byMeaning.js";

function experience(id: string, overrides: Partial<Experience> = {}): Experience {
  return {
    id,
    task: `task-${id}`,
    observation: `observation-${id}`,
    relatedNodes: [],
    confidence: 0.7,
    timestamp: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Every hit is short-tier unless a test says otherwise, so the pre-§24.5 fusion assertions stay unaffected by the boost (short's multiplier is 1). */
const leg = (
  name: MeaningLeg,
  ids: string[],
  score = 1,
  tierById: Record<string, MemoryTier> = {}
) => ({
  leg: name,
  hits: ids.map<ExperienceSearchHit>((id) => ({
    experience: experience(id),
    score,
    tier: tierById[id] ?? "short",
  })),
});

describe("toExperienceTsQuery (spec.md §24.2.1)", () => {
  it("ORs the question's content words — a why-question overlaps its answer on only a couple of terms, so ANDing returns nothing", () => {
    expect(toExperienceTsQuery("Why does the record parser skip __proto__?")).toBe(
      // The underscores are kept here rather than split on: this function's
      // job is to hand Postgres the terms, and `to_tsquery('english', ...)`
      // then normalizes `__proto__` to the lexeme `proto` on BOTH sides (query
      // and indexed document), so the match still lands. Stripping them in TS
      // instead would only duplicate work the text-search config already does.
      "record | parser | skip | __proto__"
    );
  });

  it("splits camelCase and dotted identifiers so their parts can match", () => {
    expect(toExperienceTsQuery("what does $ZodCatch do in regexes.ts")).toBe(
      "zod | catch | regexes"
    );
  });

  it("emits nothing for an all-stopword question rather than an invalid tsquery", () => {
    expect(toExperienceTsQuery("why is it that we do this?")).toBe("");
  });

  it("strips every character to_tsquery would read as syntax, so a question can never be injected into the query", () => {
    const q = toExperienceTsQuery("does foo & bar | baz ! (qux) <-> quux :* work?");
    expect(q).toBe("foo | bar | baz | qux | quux | work");
    expect(q.replace(/ \| /g, "")).toMatch(/^[a-z0-9_]*$/);
  });
});

describe("fuseLegs (spec.md §24.4 — §9's hybrid shape over experience content)", () => {
  it("ranks by rank position, not by leg-native score, so a tiny ts_rank still beats a large cosine at a worse rank", () => {
    // The exact failure a Math.max merge would have: `text` reports 0.02,
    // `vector` reports 0.98, but `text` has the better-ranked answer.
    const fused = fuseLegs([leg("text", ["answer"], 0.02), leg("vector", ["noise", "answer"], 0.98)]);
    expect(fused[0]?.experience.id).toBe("answer");
  });

  it("promotes an experience that more than one leg agreed on", () => {
    const fused = fuseLegs([
      leg("text", ["only-text", "both"]),
      leg("trigram", ["both"]),
      leg("vector", ["both"]),
    ]);
    expect(fused[0]?.experience.id).toBe("both");
    expect(fused[0]?.reason).toBe("hybrid_match");
    expect(fused[0]?.legs).toEqual(["text", "trigram", "vector"]);
  });

  it("tags a single-leg hit with that leg's §9-style reason", () => {
    expect(fuseLegs([leg("text", ["a"])])[0]?.reason).toBe("text_match");
    expect(fuseLegs([leg("trigram", ["a"])])[0]?.reason).toBe("lexical_match");
    expect(fuseLegs([leg("vector", ["a"])])[0]?.reason).toBe("semantic_match");
  });

  it("weights the full-text leg above the two unmeasured legs at equal rank", () => {
    expect(DEFAULT_LEG_WEIGHTS.text).toBeGreaterThan(DEFAULT_LEG_WEIGHTS.vector);
    const fused = fuseLegs([leg("vector", ["from-vector"]), leg("text", ["from-text"])]);
    expect(fused.map((h) => h.experience.id)).toEqual(["from-text", "from-vector"]);
  });

  it("reports whether a memory is anchored without requiring it — ranking never reads the field", () => {
    const fused = fuseLegs([
      {
        leg: "text",
        hits: [
          { experience: experience("anchorless", { relatedNodes: [] }), score: 0.1, tier: "short" as const },
          {
            experience: experience("anchored", { relatedNodes: ["src/a.ts"] }),
            score: 0.05,
            tier: "short" as const,
          },
          // M12: the typed `anchors` column counts too, on its own.
          {
            experience: experience("typed-anchor", { anchors: [{ path: "src/b.ts" }] }),
            score: 0.04,
            tier: "short" as const,
          },
        ],
      },
    ]);
    expect(fused[0]?.experience.id).toBe("anchorless");
    expect(fused[0]?.anchored).toBe(false);
    expect(fused[1]?.anchored).toBe(true);
    expect(fused[2]?.anchored).toBe(true);
  });

  it("breaks score ties deterministically: newer knowledge first, then id", () => {
    const hits = [
      { experience: experience("b", { timestamp: "2026-01-01T00:00:00.000Z" }), score: 1, tier: "short" as const },
      { experience: experience("a", { timestamp: "2026-01-01T00:00:00.000Z" }), score: 1, tier: "short" as const },
      { experience: experience("c", { timestamp: "2026-06-01T00:00:00.000Z" }), score: 1, tier: "short" as const },
    ];
    // All at rank 0 in their own leg -> identical fused score.
    const fused = fuseLegs([
      { leg: "text", hits: [hits[0]!] },
      { leg: "text", hits: [hits[1]!] },
      { leg: "text", hits: [hits[2]!] },
    ]);
    expect(fused.map((h) => h.experience.id)).toEqual(["c", "a", "b"]);
  });

  it("counts a duplicate hit within one leg once", () => {
    const fused = fuseLegs([leg("text", ["dup", "dup", "other"])]);
    expect(fused.filter((h) => h.experience.id === "dup")).toHaveLength(1);
    expect(fused[0]?.legs).toEqual(["text"]);
  });

  it("honours the limit", () => {
    const fused = fuseLegs([leg("text", ["a", "b", "c", "d"])], { limit: 2 });
    expect(fused).toHaveLength(2);
  });

  it("returns nothing when every leg came back empty", () => {
    expect(fuseLegs([leg("text", []), leg("trigram", []), leg("vector", [])])).toEqual([]);
  });
});

describe("length prior (2026-08-28 real-prompt calibration)", () => {
  it("leaves bodies at or under the free size alone and damps a 21 KB body to ~0.3x", () => {
    expect(lengthPrior(LENGTH_PRIOR_FREE_CHARS)).toBe(1);
    expect(lengthPrior(21_751)).toBeCloseTo(1 / (1 + Math.log(21_751 / 2000)), 6);
  });

  it("drops a huge body below a short one at the same fused rank, and reports the undamped content score", () => {
    const huge = { experience: experience("huge", { observation: "x".repeat(21_751) }), score: 1, tier: "short" as const };
    const fused = fuseLegs([
      { leg: "text", hits: [huge] },
      { leg: "vector", hits: [{ experience: experience("short"), score: 1, tier: "short" }] },
    ], { legWeights: { text: 1, vector: 1 } });
    expect(fused.map((h) => h.experience.id)).toEqual(["short", "huge"]);
    expect(fused[1]?.contentScore).toBeCloseTo(fused[0]?.contentScore ?? 0, 9);
  });
});

describe("tier ranking boost (spec.md §24.5: a §11 multiplier, never a filter)", () => {
  it("applies the tier multiplier to the fused score and reports the unboosted content score alongside it", () => {
    const fused = fuseLegs([leg("text", ["hot"], 1, { hot: "long" })]);
    const hit = fused[0]!;
    expect(hit.tier).toBe("long");
    expect(hit.contentScore).toBeLessThan(hit.score);
    expect(hit.score).toBeCloseTo(hit.contentScore * TIER_BOOST.long, 10);
  });

  it("lets a hot-tier memory overtake a cold one on a near-tie", () => {
    // Adjacent ranks in the same leg differ by well under the boost cap, so
    // this is exactly the case tiers are meant to decide: two memories the
    // content ranking cannot separate, one of which has repeatedly been
    // useful.
    const fused = fuseLegs([leg("text", ["cold-first", "hot-second"], 1, { "hot-second": "long" })]);
    expect(fused.map((h) => h.experience.id)).toEqual(["hot-second", "cold-first"]);
  });

  it("does NOT let a hot tier overturn a real content-relevance gap — a cold memory that actually answers the question still wins", () => {
    // 30 ranks apart in the text leg: an RRF score gap far wider than the
    // 1.25x boost cap can close. §24.5's hard requirement is that retrieval
    // "must never miss a correct cold memory outright — it may only rank it
    // lower", and a multiplier with a bounded spread is what makes that
    // checkable.
    const ids = Array.from({ length: 31 }, (_, i) => (i === 0 ? "cold-best-match" : `filler-${i}`));
    ids[30] = "hot-weak-match";
    const fused = fuseLegs([leg("text", ids, 1, { "hot-weak-match": "long" })], { limit: 31 });

    const cold = fused.find((h) => h.experience.id === "cold-best-match")!;
    const hot = fused.find((h) => h.experience.id === "hot-weak-match")!;
    expect(fused[0]?.experience.id).toBe("cold-best-match");
    expect(hot.score).toBeLessThan(cold.score);

    // Still present at a real position — ranked lower, never filtered out.
    // It *did* move up (RRF scores are nearly flat in the tail, so a fixed
    // multiplier crosses more ranks there than near the top; see fuseLegs).
    // That is the boost doing its job where the content ranking has least to
    // say, and it is bounded: the boosted score cannot reach the best match's.
    expect(fused.indexOf(hot)).toBeGreaterThan(0);
    expect(fused).toHaveLength(31);
  });

  it("never drops a tier from the result set — every tier is searched and returned", () => {
    const fused = fuseLegs([
      leg("text", ["s", "m", "l"], 1, { m: "mid", l: "long" }),
    ]);
    expect(fused.map((h) => h.tier).sort()).toEqual(["long", "mid", "short"]);
  });
});
