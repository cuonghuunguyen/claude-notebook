import { describe, expect, it } from "vitest";
import { isExplanatory, lessonFrom } from "./corpus.js";

/**
 * The selection rule that decides what is worth remembering, moved out of
 * `eval/why-spike` by M11 and — deliberately, see `EXPLANATORY_VOCABULARY` —
 * widened there from one dialect of self-explanation (repair) to two (repair
 * and decision).
 *
 * These cases pin both dialects. They are not a claim that the rule is
 * unchanged: it is changed, which is exactly why BENCHMARKS.md reports the
 * zod measurement on BOTH the original and the widened corpus rather than
 * treating one number as comparable to the other.
 */
describe("explanatory-commit selection", () => {
  const longWhy =
    "The obvious implementation kept the parser's success value on the stack, " +
    "which meant an early return from the optional-key branch discarded it and " +
    "the caller saw undefined instead of the parsed object. We assign before " +
    "returning instead, because the fastpass has no other place to put it and " +
    "the alternative would mean re-walking the shape on every optional key.";

  it("keeps a commit whose body explains why", () => {
    expect(isExplanatory("fix: object fastpass dropped its result", longWhy)).toBe(true);
  });

  it("drops a commit with no body — nothing there a future agent could not re-derive from the diff", () => {
    expect(isExplanatory("fix typo", "")).toBe(false);
  });

  it("drops a long body with no explanatory vocabulary at all", () => {
    expect(isExplanatory("chore: release", "v4.1.0\n\n".repeat(40))).toBe(false);
  });

  it("does not count trailer lines toward the body-length floor", () => {
    const trailers = Array.from({ length: 12 }, (_, i) => `Co-authored-by: dev${i} <d@e.com>`).join("\n");
    expect(trailers.length).toBeGreaterThan(200);
    expect(isExplanatory("fix: something", trailers)).toBe(false);
  });

  it("keeps a decision commit that never mentions a bug — the class spec.md §24.2.1 names first", () => {
    // Verbatim shape of this repo's own spec.md §24 pivot commit, which the
    // repair-only vocabulary rejected despite 800 characters of reasoning.
    const decision =
      "Direct human decision (2026-08-19). The benchmarks made the case: the multi-repo " +
      "report shows the structural graph loses to a naive baseline at code location in " +
      "every regime, while the why-memory spike shows recorded-reasoning memory wins on " +
      "turns via retrieval by content, not node hits. The knowledge layer is therefore " +
      "the product; the graph was at most a coordinate system, and a cheaper one exists.";
    expect(decision.length).toBeGreaterThan(200);
    expect(/\b(fix|revert|regress|workaround|perf|breaking|bug)\b/i.test(decision)).toBe(false);
    expect(isExplanatory("Pivot to knowledge-first memory", decision)).toBe(true);
  });

  it("keeps a commit that explains a choice between two designs", () => {
    const body =
      "Chosen over a bi-temporal model: supersede chains plus creation timestamps already " +
      "answer what we believed at a given time by walking the chain, and tiers answer the " +
      "different question that bi-temporality does not, which is what is worth keeping and " +
      "ranking up. Adopting both would have meant two overlapping mechanisms for one job.";
    expect(isExplanatory("Add memory tiers", body)).toBe(true);
  });

  it("renders the lesson as subject + body, with trailers stripped", () => {
    const lesson = lessonFrom({
      sha: "a".repeat(40),
      shortSha: "aaaaaaaa",
      date: "2026-01-01T00:00:00Z",
      subject: "fix: keep the fastpass result",
      body: `${longWhy}\n\nSigned-off-by: dev <d@e.com>`,
      files: ["src/parse.ts"],
    });
    expect(lesson.startsWith("fix: keep the fastpass result")).toBe(true);
    expect(lesson).toContain("re-walking the shape");
    expect(lesson).not.toContain("Signed-off-by");
  });
});
