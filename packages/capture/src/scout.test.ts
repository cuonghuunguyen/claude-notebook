import { describe, expect, it } from "vitest";
import {
  BareLocationsError,
  MIN_PROSE_WORDS,
  MIN_UNDERSTANDING_CHARS,
  assertSynthesizedUnderstanding,
  proseWordCount,
  scoutAction,
} from "./scout.js";

/**
 * spec.md §24.2.1's guardrail is a measured rule, not a style preference:
 * `E2E_BENCHMARK_MULTI_REPO.md` showed grep answering "where is X" in one turn,
 * so a location-only memory buys no turns and only adds staleness risk. These
 * cases pin the boundary it draws.
 */
describe("scout-report guardrail (spec.md §24.2.1)", () => {
  const realUnderstanding = `
    Retrieval runs two independent legs and merges them rather than picking one.
    The lexical leg uses trigram similarity because the english stemmer mangles
    camelCase identifiers, and the vector leg is skipped entirely when no
    embedder is injected, which is why a query can come back with hits that all
    say lexical_match. The merge scores a node by its best leg instead of summing
    the two, because the two similarities are not on the same scale, and a node
    hit by both legs is tagged as a hybrid match. The gotcha is that seeds are
    then expanded by one structural hop from only the top three hits, so a
    relevant node that ranked fourth is never expanded from at all.
  `;

  it("accepts a genuine synthesized walkthrough", () => {
    expect(() => assertSynthesizedUnderstanding(realUnderstanding)).not.toThrow();
  });

  it("rejects a bare file listing even when it is long enough to pass the length floor", () => {
    const listing = `
      - packages/episodic/src/byMeaning.ts
      - packages/episodic/src/record.ts
      - packages/episodic/src/query.ts
      - packages/episodic/src/supersede.ts
      - packages/core/src/embedding.ts
      - packages/graph-store/src/nodes.ts
      - packages/graph-store/src/edges.ts
      - packages/staleness/src/memoryStaleness.ts
    `;
    expect(listing.trim().length).toBeGreaterThan(MIN_UNDERSTANDING_CHARS);
    expect(() => assertSynthesizedUnderstanding(listing)).toThrow(BareLocationsError);
  });

  it("rejects a location list wearing prose punctuation", () => {
    const disguised = `
      queryByMeaning lives in packages/episodic/src/byMeaning.ts and
      recordExperience lives in packages/episodic/src/record.ts. runPipeline is
      in packages/pipeline/src/pipeline.ts, searchExperiencesByTrigram is in
      packages/graph-store/src/experiences.ts and flagPossiblyStale is in
      packages/staleness/src/memoryStaleness.ts.
    `;
    expect(disguised.trim().length).toBeGreaterThan(MIN_UNDERSTANDING_CHARS);
    expect(() => assertSynthesizedUnderstanding(disguised)).toThrow(BareLocationsError);
  });

  it("rejects a one-liner outright", () => {
    expect(() => assertSynthesizedUnderstanding("Retrieval is in packages/episodic.")).toThrow(
      /below the 200-char floor/
    );
  });

  it("names spec.md §24.2.1 in the rejection, so the caller learns the rule and not just that it failed", () => {
    try {
      assertSynthesizedUnderstanding("too short");
      throw new Error("expected a rejection");
    } catch (err) {
      expect((err as Error).message).toContain("§24.2.1");
      expect((err as Error).message).toContain("synthesized");
    }
  });

  it("counts only prose words, discarding paths and dotted symbol references", () => {
    const text =
      "See packages/episodic/src/byMeaning.ts and fuseLegs.score plus query.ts for the fusion rule";
    // Pinned exactly, so this test fails if the stripping stops working rather
    // than passing on the raw word count alone: "See and plus for the merge
    // rule" is 7 words; the raw text has 12 once its separators are split.
    expect(proseWordCount(text)).toBe(7);
    expect(text.split(/[^A-Za-z']+/).filter((w) => w.length > 1).length).toBeGreaterThan(7);
    // ...and 7 is genuinely below the floor, which is what makes such a text a
    // rejection rather than an accepted report.
    expect(proseWordCount(text)).toBeLessThan(MIN_PROSE_WORDS);
  });

  it("tags the memory's provenance with the reporting session when one is given", () => {
    expect(scoutAction("session-abc")).toBe("scout-report session-abc");
    expect(scoutAction()).toBe("scout-report");
  });
});
