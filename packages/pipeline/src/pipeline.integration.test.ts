import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeEmbedder } from "@cognitive-memory/core";
import { closePool, runMigrations, upsertExperienceEmbedding } from "@cognitive-memory/graph-store";
import { recordExperience } from "@cognitive-memory/episodic";
import { runPipeline } from "./pipeline.js";

// Same DATABASE_URL-gating convention as every other integration suite in
// this repo — skipped, not failed, without a real Postgres.
const hasDb = Boolean(process.env["DATABASE_URL"]);
const d = hasDb ? describe : describe.skip;

/**
 * spec.md §22 end to end against a real database.
 *
 * Until M15 the cases here built a fixture *structural* graph — nodes, edges,
 * a repo id — and asserted that a task string reached the right subsystem,
 * source files and relationships through retrieval and traversal. There is no
 * structural graph to build any more, and the assertion that matters is the
 * one the last of those cases already made: a real task string reaches real
 * recorded knowledge with nothing code-shaped in between.
 */
d("runPipeline integration", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await closePool();
  });

  it("goes from a task string to an AgentContext carrying the memory that answers it (spec.md §22)", async () => {
    const marker = randomUUID().replace(/-/g, "");
    const recorded = await recordExperience({
      task: `why the ${marker} anchor helper exists`,
      observation:
        `The ${marker} ISO date regex is assembled through an anchor helper instead of an ` +
        `inline template literal because esbuild refuses to treat an interpolated regex ` +
        `literal as pure, so its dead-code pass kept the entire module in every bundle.`,
      lessons: [`the ${marker} anchor helper exists for esbuild purity, not readability`],
      // Nothing code-shaped to gate on — and since M15, nothing that could be.
      relatedNodes: [],
      confidence: 0.7,
    });

    const result = await runPipeline(
      `${marker} why is the iso regex built through a helper rather than inline`,
      { embedder: createFakeEmbedder() }
    );

    expect(result.context.experiences.map((e) => e.experienceId)).toContain(recorded.id);
    expect(result.context.experiences.find((e) => e.experienceId === recorded.id)?.lessons).toEqual([
      `the ${marker} anchor helper exists for esbuild purity, not readability`,
    ]);
    expect(result.byMeaning.map((h) => h.experience.id)).toContain(recorded.id);
    expect(result.byMeaning.find((h) => h.experience.id === recorded.id)?.anchored).toBe(false);
  });

  it("calls a real embedder's embed() exactly once per invocation (spec.md §22 step 1)", async () => {
    const real = createFakeEmbedder();
    let calls = 0;
    const counting = {
      async embed(text: string): Promise<number[]> {
        calls += 1;
        return real.embed(text);
      },
    };

    await runPipeline(`embed-once-${randomUUID()}`, { embedder: counting });

    expect(calls).toBe(1);
  });

  it("finds a memory through the vector leg with the embedding written at capture time", async () => {
    const marker = randomUUID().replace(/-/g, "");
    const embedder = createFakeEmbedder();
    const recorded = await recordExperience({
      task: `${marker} prototype methods retain memory in v8`,
      observation:
        `Moving schema methods onto the ${marker} prototype cut bundle size but made v8 ` +
        `retain more memory per instance, because inline slots no longer covered the ` +
        `method properties.`,
      relatedNodes: [],
      confidence: 0.7,
    });
    await upsertExperienceEmbedding(
      recorded.id,
      await embedder.embed(`${recorded.task} ${recorded.observation}`)
    );

    const result = await runPipeline(
      `${marker} why do prototype methods make v8 retain more memory per instance`,
      { embedder }
    );

    const hit = result.byMeaning.find((h) => h.experience.id === recorded.id);
    expect(hit).toBeDefined();
    expect(hit?.legs).toContain("vector");
  });

  it("returns an empty context rather than throwing when nothing matches at all", async () => {
    const result = await runPipeline(`no-such-knowledge-${randomUUID().replace(/-/g, "")}`, {});

    expect(result.byMeaning).toEqual([]);
    expect(result.context.experiences).toEqual([]);
  });
});
