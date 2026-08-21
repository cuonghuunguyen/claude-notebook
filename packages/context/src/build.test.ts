import { describe, expect, it } from "vitest";
import type { Experience } from "@cognitive-memory/core";
import { POSSIBLY_STALE_FLAG } from "@cognitive-memory/core";
import { buildContext, DEFAULT_MAX_EXPERIENCES } from "./build.js";
import type { Subgraph } from "./types.js";

const NOW = new Date().toISOString();

function makeExperience(id: string, overrides: Partial<Experience> = {}): Experience {
  return {
    id,
    task: "task",
    observation: "observation",
    relatedNodes: [],
    confidence: 0.5,
    timestamp: NOW,
    ...overrides,
  };
}

describe("buildContext", () => {
  it("orders prior experience by timestamp descending (most recent lesson first)", () => {
    const subgraph: Subgraph = {
      experiences: [
        makeExperience("old", { timestamp: "2026-01-01T00:00:00.000Z" }),
        makeExperience("new", { timestamp: "2026-03-01T00:00:00.000Z" }),
      ],
    };

    const context = buildContext(subgraph, "task");

    expect(context.experiences.map((e) => e.experienceId)).toEqual(["new", "old"]);
  });

  it("breaks a timestamp tie by id so the projection is deterministic", () => {
    const subgraph: Subgraph = {
      experiences: [makeExperience("b"), makeExperience("a")],
    };

    expect(buildContext(subgraph, "task").experiences.map((e) => e.experienceId)).toEqual(["a", "b"]);
  });

  it("carries a memory's lessons and outcome through, and defaults lessons to an empty list", () => {
    const subgraph: Subgraph = {
      experiences: [
        makeExperience("with", { lessons: ["do not do that"], result: "reverted" }),
        makeExperience("without"),
      ],
    };

    const context = buildContext(subgraph, "task");

    expect(context.experiences).toEqual([
      { experienceId: "with", task: "task", lessons: ["do not do that"], result: "reverted" },
      { experienceId: "without", task: "task", lessons: [], result: undefined },
    ]);
  });

  it("surfaces §24.2.3's staleness flag on a suspect memory without dropping it", () => {
    const subgraph: Subgraph = {
      experiences: [
        makeExperience("flagged", { suspect: true, suspectReason: "modified src/a.ts in a1b2c3d4" }),
      ],
    };

    const context = buildContext(subgraph, "task");

    expect(context.experiences).toHaveLength(1);
    expect(context.experiences[0]?.staleness).toBe(POSSIBLY_STALE_FLAG);
    expect(context.experiences[0]?.stalenessReason).toBe("modified src/a.ts in a1b2c3d4");
  });

  it("caps experiences, and caps them by recency (the documented contract callers clamp against)", () => {
    // Deliberately asserting the behaviour `packages/pipeline` exists to work
    // around: the cap is applied AFTER the recency sort, so handing in more
    // relevance-ranked memories than the cap loses the oldest ones however
    // relevant they were. `experienceBudget` in the pipeline clamps to
    // DEFAULT_MAX_EXPERIENCES for exactly this reason.
    const experiences = Array.from({ length: DEFAULT_MAX_EXPERIENCES + 2 }, (_, i) =>
      makeExperience(`e${i}`, { timestamp: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z` })
    );

    const context = buildContext({ experiences }, "task");

    expect(context.experiences).toHaveLength(DEFAULT_MAX_EXPERIENCES);
    expect(context.experiences[0]?.experienceId).toBe(`e${DEFAULT_MAX_EXPERIENCES + 1}`);
    expect(context.experiences.map((e) => e.experienceId)).not.toContain("e0");
  });

  it("honours an explicit maxExperiences override", () => {
    const subgraph: Subgraph = {
      experiences: [makeExperience("a"), makeExperience("b"), makeExperience("c")],
    };

    expect(buildContext(subgraph, "task", { maxExperiences: 1 }).experiences).toHaveLength(1);
  });

  it("returns an empty projection for an empty subgraph rather than throwing", () => {
    expect(buildContext({}, "task")).toEqual({ task: "task", experiences: [] });
    expect(buildContext({ experiences: [] }, "task")).toEqual({ task: "task", experiences: [] });
  });
});
