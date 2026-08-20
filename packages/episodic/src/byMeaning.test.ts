import { describe, expect, it } from "vitest";
import type { Experience } from "@cognitive-memory/core";
import type { ExperienceSearchHit } from "@cognitive-memory/graph-store";
import { DEFAULT_LEG_WEIGHTS, fuseLegs, toExperienceTsQuery, type MeaningLeg } from "./byMeaning.js";

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

const leg = (name: MeaningLeg, ids: string[], score = 1) => ({
  leg: name,
  hits: ids.map<ExperienceSearchHit>((id) => ({ experience: experience(id), score })),
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
          { experience: experience("anchorless", { relatedNodes: [] }), score: 0.1 },
          { experience: experience("anchored", { relatedNodes: ["src/a.ts"] }), score: 0.05 },
        ],
      },
    ]);
    expect(fused[0]?.experience.id).toBe("anchorless");
    expect(fused[0]?.anchored).toBe(false);
    expect(fused[1]?.anchored).toBe(true);
  });

  it("breaks score ties deterministically: newer knowledge first, then id", () => {
    const hits = [
      { experience: experience("b", { timestamp: "2026-01-01T00:00:00.000Z" }), score: 1 },
      { experience: experience("a", { timestamp: "2026-01-01T00:00:00.000Z" }), score: 1 },
      { experience: experience("c", { timestamp: "2026-06-01T00:00:00.000Z" }), score: 1 },
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
