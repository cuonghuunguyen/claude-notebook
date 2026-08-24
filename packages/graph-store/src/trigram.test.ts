import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { trigramSequence, trigramSet, wordSimilarity } from "./trigram.js";

/**
 * The port's trigram leg is a JS reimplementation of `pg_trgm`'s
 * `word_similarity` (see `trigram.ts` for why it is not FTS5's trigram
 * tokenizer). This file is what makes "same function" a checkable claim rather
 * than an assertion: every expected value below was produced by
 * `SELECT word_similarity($1, $2)` on a live Postgres 16 with pg_trgm — the
 * same instance M17's baseline eval ran against — and dumped to the fixture.
 *
 * 40 synthetic cases cover normalization, padding, duplicates, word order and
 * extent boundaries; 30 are real (eval question, mined memory text) pairs from
 * the gate corpus, with scores from 0.257 to 0.605, straddling the 0.35
 * threshold the leg filters on.
 */
interface Case {
  query: string;
  text: string;
  wordSimilarity: number;
  /**
   * pg_trgm's C implementation searches extents greedily rather than
   * exhaustively, so on a small number of real pairs it reports slightly LESS
   * than the maximum its own documentation defines. Marked rather than removed:
   * see `trigram.ts` for the measured size of the gap (34 of 1,420 pairs on the
   * gate corpus, largest difference 0.0073, no threshold crossings).
   */
  greedyDivergence?: boolean;
}

const fixture = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "pgTrgmWordSimilarity.json");
const CASES = JSON.parse(readFileSync(fixture, "utf-8")) as Case[];

const label = (value: string): string =>
  value.length > 40 ? `${value.slice(0, 40)}...` : value || "(empty)";

describe("pg_trgm normalization (show_trgm, verified against Postgres)", () => {
  it("pads each word with two leading spaces and one trailing, giving n+1 trigrams", () => {
    expect(trigramSequence("cat")).toEqual(["  c", " ca", "cat", "at "]);
    // Even a single character contributes two, which is what makes a one-letter
    // query term match at all.
    expect(trigramSequence("a")).toEqual(["  a", " a "]);
  });

  it("treats every non-alphanumeric character as a word separator, `_` included", () => {
    // `show_trgm('a1_b')` is {"  a","  b"," a1"," b ","a1 "} — two words. An
    // implementation that kept `_` inside the word would score every
    // snake_case identifier differently from Postgres.
    expect(trigramSet("a1_b")).toEqual(new Set(["  a", " a1", "a1 ", "  b", " b "]));
    expect(trigramSet("Cat-Dog")).toEqual(trigramSet("cat dog"));
    expect(trigramSet("regexes.ts")).toEqual(trigramSet("regexes ts"));
  });

  it("keeps duplicate trigrams in the sequence but not in the set", () => {
    // The sequence is what an extent is defined over, so position matters there;
    // the score is Jaccard over sets, so `word_similarity('cat', 'cat cat')` is
    // 1 rather than 0.5.
    expect(trigramSequence("cat cat")).toHaveLength(8);
    expect(trigramSet("cat cat").size).toBe(4);
  });
});

describe("wordSimilarity agrees with pg_trgm's word_similarity", () => {
  it.each(CASES.map((testCase, index) => [index, testCase] as const))(
    "case %i: %o",
    (_index, testCase) => {
      const actual = wordSimilarity(testCase.query, testCase.text);
      if (testCase.greedyDivergence) {
        // Bounded, and bounded in the direction that cannot hide a bug: this
        // implementation may only find a LARGER maximum than pg's greedy walk,
        // never a smaller one, and never by enough to cross the threshold.
        expect(actual).toBeGreaterThanOrEqual(testCase.wordSimilarity);
        expect(actual - testCase.wordSimilarity).toBeLessThan(0.01);
      } else {
        expect(actual).toBeCloseTo(testCase.wordSimilarity, 6);
      }
    }
  );

  it("scores 0 rather than NaN for an empty or non-matching side", () => {
    for (const [query, text] of [
      ["", "cat"],
      ["cat", ""],
      ["cat", "   "],
      ["cat", "dog"],
    ]) {
      expect(wordSimilarity(query as string, text as string)).toBe(0);
    }
  });

  it("never exceeds 1 and is 1 for an exact match, on every fixture case", () => {
    for (const testCase of CASES) {
      const score = wordSimilarity(testCase.query, testCase.text);
      expect(score, label(testCase.query)).toBeGreaterThanOrEqual(0);
      expect(score, label(testCase.query)).toBeLessThanOrEqual(1);
    }
    expect(wordSimilarity("cat dog", "cat dog")).toBe(1);
  });

  it("stays fast on a long REPETITIVE body — the case the ratio bound cannot prune", () => {
    // The leg scans the whole corpus per question, so a pathological document is
    // a pathological query. This is the exact shape that caught the missing
    // saturation bound: a repetitive body's distinct-trigram count is tiny, so a
    // bound expressed in multiples of the query size never fires and every start
    // position walks to the end of the document — measured at 1.9 s for this one
    // input before the bound existed.
    const body = "the quick brown fox jumps over the lazy dog ".repeat(400);
    const started = process.hrtime.bigint();
    const score = wordSimilarity("why does the lazy dog matter here", body);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(score).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(250);
  });

  it("prunes a target that cannot reach the caller's floor without searching it", () => {
    // `minScore` is what the leg passes, and the document-level early out is
    // what makes an unrelated memory free rather than merely cheap. The
    // assertion is the contract, not the timing: at or above the floor the score
    // is exact, and below it the only claim is that it is below.
    const body = "an unrelated memory about currency rounding in invoices ".repeat(200);
    const query = "why does the JIT fastpass return early for optional keys";
    const exact = wordSimilarity(query, body);
    expect(exact).toBeLessThan(0.35);

    const started = process.hrtime.bigint();
    const floored = wordSimilarity(query, body, 0.35);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(floored).toBeLessThan(0.35);
    expect(elapsedMs).toBeLessThan(20);
  });

  it("keeps a score that lands exactly ON the floor — the boundary the bound must not prune", () => {
    // Found by a cold review pass, not by the fixture: while an extent's
    // distinct count is still below `saturation`, the pruning bound equals
    // `saturation / q`, which is not an over-estimate but the ATTAINABLE
    // supremum for that target. A non-strict comparison there prunes an extent
    // whose true score is exactly the threshold — and the leg keeps
    // `score >= threshold`, matching pg_trgm's `<%`, so Postgres returned such a
    // memory and SQLite silently did not.
    //
    // The fixture's 70 cases never land on the boundary (it needs `saturation/q`
    // to be bit-identical to 0.35, i.e. q a multiple of 20), which is exactly
    // why this case is written by hand.
    expect(wordSimilarity("parser loader config", "parser")).toBeCloseTo(0.35, 10);
    expect(wordSimilarity("parser loader config", "parser", 0.35)).toBeCloseTo(0.35, 10);

    // The general property, over every q that can reach the boundary exactly.
    for (const [query, target] of [
      ["parser loader config", "parser"],
      ["alpha bravo charlie delta", "alpha"],
    ]) {
      const exact = wordSimilarity(query as string, target as string);
      expect(wordSimilarity(query as string, target as string, exact)).toBeCloseTo(exact, 10);
    }
  });

  it("returns the same score as the unbounded search for everything at or above the floor", () => {
    // The soundness property the leg depends on: `minScore` may only prune
    // extents that cannot EXCEED the floor, so any qualifying score is
    // unaffected. Checked against every fixture case rather than argued.
    for (const testCase of CASES) {
      const exact = wordSimilarity(testCase.query, testCase.text);
      const floored = wordSimilarity(testCase.query, testCase.text, 0.35);
      if (exact >= 0.35) {
        expect(floored, label(testCase.query)).toBeCloseTo(exact, 10);
      } else {
        expect(floored, label(testCase.query)).toBeLessThan(0.35);
      }
    }
  });
});
