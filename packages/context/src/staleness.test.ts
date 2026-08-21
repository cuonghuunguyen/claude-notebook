/**
 * The staleness flag's trip through §17's projection (spec.md §24.2.3 /
 * ROADMAP.md M12): a suspect memory must reach the agent tagged, and a fresh
 * one must reach it clean.
 *
 * Kept in its own file rather than folded into `build.test.ts` /
 * `render.test.ts` because it asserts one cross-cutting behaviour over both —
 * the flag is set in `buildContext` and has to survive `renderContext`, and a
 * regression in either half is the same bug.
 */
import { describe, expect, it } from "vitest";
import { POSSIBLY_STALE_FLAG, type Experience } from "@cognitive-memory/core";
import { buildContext } from "./build.js";
import { renderContext } from "./render.js";
import type { Subgraph } from "./types.js";

function experience(overrides: Partial<Experience> = {}): Experience {
  return {
    id: "exp-1",
    task: "why the tokenizer rejects empty input",
    observation: "EOF was treated as an error token; the revert in a1b2 explains why",
    lessons: ["Empty input is a valid parse, not an error."],
    relatedNodes: [],
    anchors: [{ path: "src/parse.ts" }],
    confidence: 0.7,
    timestamp: "2026-02-01T00:00:00Z",
    ...overrides,
  };
}

const subgraphOf = (...experiences: Experience[]): Subgraph => ({ experiences });

describe("staleness in the agent context (spec.md §24.2.3)", () => {
  it("tags a suspect memory with the spec's exact wording", () => {
    const context = buildContext(
      subgraphOf(experience({ suspect: true, suspectReason: "modified src/parse.ts in a1b2c3d4" })),
      "fix the tokenizer"
    );
    expect(context.experiences[0]?.staleness).toBe(POSSIBLY_STALE_FLAG);
    expect(context.experiences[0]?.staleness).toBe("possibly-stale — verify before trusting");
    expect(context.experiences[0]?.stalenessReason).toBe("modified src/parse.ts in a1b2c3d4");
  });

  it("leaves a fresh memory untagged rather than tagging it 'fresh'", () => {
    const context = buildContext(subgraphOf(experience()), "fix the tokenizer");
    expect(context.experiences[0]?.staleness).toBeUndefined();
    expect(context.experiences[0]).not.toHaveProperty("staleness");
  });

  it("returns the suspect memory in full — flagged, never dropped", () => {
    // The measured position, not a courtesy: WHY_MEMORY_SPIKE.md priced missing
    // context in agent turns, so a doubtful memory still beats no memory.
    const context = buildContext(
      subgraphOf(experience({ suspect: true })),
      "fix the tokenizer"
    );
    expect(context.experiences).toHaveLength(1);
    expect(context.experiences[0]?.lessons).toEqual([
      "Empty input is a valid parse, not an error.",
    ]);
  });

  it("renders the warning on the entry's first line, where a skimming agent reads", () => {
    const context = buildContext(
      subgraphOf(
        experience({
          result: "reverted",
          suspect: true,
          suspectReason: "modified src/parse.ts in a1b2c3d4",
        })
      ),
      "fix the tokenizer"
    );
    const rendered = renderContext(context);
    const headline = rendered
      .split("\n")
      .find((line) => line.includes("why the tokenizer rejects empty input"));
    expect(headline).toContain(POSSIBLY_STALE_FLAG);
    expect(headline).toContain("modified src/parse.ts in a1b2c3d4");
  });

  it("renders a flag with no reason without a dangling empty parenthesis", () => {
    const context = buildContext(subgraphOf(experience({ suspect: true })), "task");
    const rendered = renderContext(context);
    expect(rendered).toContain(POSSIBLY_STALE_FLAG);
    expect(rendered).not.toContain("()");
  });

  it("does not mention staleness anywhere when nothing is suspect", () => {
    const rendered = renderContext(buildContext(subgraphOf(experience()), "task"));
    expect(rendered).not.toContain("possibly-stale");
  });

  it("flags only the suspect entries in a mixed batch", () => {
    const context = buildContext(
      subgraphOf(
        experience({ id: "stale", timestamp: "2026-03-01T00:00:00Z", suspect: true }),
        experience({ id: "fresh", timestamp: "2026-02-01T00:00:00Z" })
      ),
      "task"
    );
    const byId = new Map(context.experiences.map((e) => [e.experienceId, e]));
    expect(byId.get("stale")?.staleness).toBe(POSSIBLY_STALE_FLAG);
    expect(byId.get("fresh")?.staleness).toBeUndefined();
  });
});
