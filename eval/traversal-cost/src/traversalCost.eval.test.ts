import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_TRAVERSAL_BUDGET } from "@cognitive-memory/core";
import { closePool, runMigrations } from "@cognitive-memory/graph-store";
import { createPostgresGraphProvider, expandAllReasoner, traverse } from "@cognitive-memory/traversal";
import { buildTraversalCostFixture, type TraversalCostFixture } from "./fixture.js";

// Same DATABASE_URL-gating convention as every other integration/eval suite
// in this repo — skipped, not failed, without a real Postgres.
const hasDb = Boolean(process.env["DATABASE_URL"]);
const d = hasDb ? describe : describe.skip;

d("traversal-cost eval set (spec.md §19 point 4 / ROADMAP.md M7)", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await closePool();
  });

  it("never consumes more nodes/edges/reasoning-calls than the budget allows, for every seed in the fixture", async () => {
    const fixture: TraversalCostFixture = await buildTraversalCostFixture();
    const seeds = [fixture.mainId, fixture.stepAId, fixture.stepBId, fixture.stepCId, fixture.noiseId];

    const results = await Promise.all(
      seeds.map((seed) =>
        traverse([seed], "trace this pipeline's call chain", {
          graph: createPostgresGraphProvider(),
          reasoner: expandAllReasoner(),
          budget: DEFAULT_TRAVERSAL_BUDGET,
        })
      )
    );

    for (const result of results) {
      expect(result.reasoningStepsUsed).toBeLessThanOrEqual(DEFAULT_TRAVERSAL_BUDGET.maxReasoningSteps);
      expect(result.nodeIds.length).toBeLessThanOrEqual(DEFAULT_TRAVERSAL_BUDGET.maxNodes);
      expect(result.edges.length).toBeLessThanOrEqual(DEFAULT_TRAVERSAL_BUDGET.maxEdges);
    }

    // spec.md §19 point 4: "if tasks routinely hit maxReasoningSteps without
    // reaching STOP naturally, the default budget or the ranking function
    // needs tuning, not a bigger budget." On a fixture this small, at least
    // one seed's traversal must terminate on its own (no_frontier /
    // no_expansion / reasoner_stop) — if EVERY seed exhausted the budget
    // here, that would itself be evidence of mistuning, not a coincidence.
    const exhaustedCount = results.filter((r) => r.stopReason === "budget_exhausted").length;
    expect(exhaustedCount).toBeLessThan(results.length);
  });

  it("a deliberately tiny budget does report budget_exhausted — the tracking itself isn't a false negative", async () => {
    const fixture: TraversalCostFixture = await buildTraversalCostFixture();

    const result = await traverse([fixture.mainId], "trace this pipeline's call chain", {
      graph: createPostgresGraphProvider(),
      reasoner: expandAllReasoner(),
      budget: { ...DEFAULT_TRAVERSAL_BUDGET, maxReasoningSteps: 1, maxNodes: 2 },
    });

    expect(result.stopReason).toBe("budget_exhausted");
    expect(result.reasoningStepsUsed).toBeLessThanOrEqual(1);
  });
});
