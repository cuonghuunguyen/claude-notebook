import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddingProvider, Experience } from "@cognitive-memory/core";

/**
 * `runPipeline` reaches `queryByMeaning` through a hardcoded module import,
 * not an injected parameter (per spec.md §22 — only `embedder` is injected),
 * and the real implementation hits Postgres. To keep this suite DB-free — the
 * acceptance criterion's whole point, contrasted with
 * `pipeline.integration.test.ts` — that one module boundary is mocked here.
 *
 * Before M15 this list was four boundaries long: `retrieveSeeds` (retrieval),
 * `getNodesByIds` (graph-store), `queryByNode` and `queryByMeaning`
 * (episodic), plus fixture implementations of traversal's injected
 * `GraphProvider` and `ReasoningProvider`. All of that composition is gone with
 * the structural graph; what is left is one retrieval call, one staleness pass
 * and one projection.
 */
vi.mock("@cognitive-memory/episodic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cognitive-memory/episodic")>()),
  queryByMeaning: vi.fn(),
}));

import { queryByMeaning, type ScoredExperience } from "@cognitive-memory/episodic";
import { runPipeline } from "./pipeline.js";

const mockQueryByMeaning = vi.mocked(queryByMeaning);

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

function makeMeaningHit(experience: Experience, score: number): ScoredExperience {
  return {
    experience,
    score,
    contentScore: score,
    tier: "short",
    legs: ["text"],
    reason: "text_match",
    anchored: experience.relatedNodes.length > 0,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

beforeEach(() => {
  mockQueryByMeaning.mockResolvedValue([]);
});

describe("runPipeline", () => {
  it("composes by-meaning retrieval -> buildContext in one call", async () => {
    const hit = makeExperience("mem-1", {
      task: "why the fastpass assigns before returning",
      lessons: ["assign before returning in the fastpass"],
      result: "fixed",
    });
    mockQueryByMeaning.mockResolvedValue([makeMeaningHit(hit, 0.9)]);

    const result = await runPipeline("why does the fastpass return undefined", {});

    expect(mockQueryByMeaning).toHaveBeenCalledTimes(1);
    expect(mockQueryByMeaning.mock.calls[0]?.[0]).toBe("why does the fastpass return undefined");
    expect(result.context.task).toBe("why does the fastpass return undefined");
    expect(result.context.experiences.map((e) => e.experienceId)).toEqual(["mem-1"]);
    expect(result.context.experiences[0]?.lessons).toEqual([
      "assign before returning in the fastpass",
    ]);
    expect(result.byMeaning.map((h) => h.experience.id)).toEqual(["mem-1"]);
  });

  it("returns an empty-but-valid context when the memory has nothing to say", async () => {
    const result = await runPipeline("a task nothing was recorded about", {});

    expect(result.context).toEqual({ task: "a task nothing was recorded about", experiences: [] });
    expect(result.byMeaning).toEqual([]);
    expect(result.staleness).toEqual([]);
  });

  it("surfaces a hit with no anchors at all — knowledge is not node-gated (spec.md §24.2.1/§24.3)", async () => {
    // The case §24.3 records as §23's mistake: before M11, "no structural node
    // matches this task" also meant "the memory has nothing to say about it".
    // After M15 there is no structural node for it to mean anything about.
    const anchorless = makeExperience("anchorless", { relatedNodes: [], anchors: [] });
    mockQueryByMeaning.mockResolvedValue([makeMeaningHit(anchorless, 0.4)]);

    const result = await runPipeline("task", {});

    expect(result.context.experiences.map((e) => e.experienceId)).toEqual(["anchorless"]);
    expect(result.byMeaning[0]?.anchored).toBe(false);
  });

  it("orders the context by recency while keeping by-meaning's own ranking on the result", async () => {
    // The asymmetry PipelineResult.staleness documents: `context.experiences`
    // is recency-sorted by buildContext, `byMeaning` keeps fusion rank. The
    // top-ranked answer to a "why" question is frequently the older memory.
    const best = makeExperience("best-and-oldest", { timestamp: "2019-01-01T00:00:00.000Z" });
    const other = makeExperience("newer", { timestamp: "2026-01-01T00:00:00.000Z" });
    mockQueryByMeaning.mockResolvedValue([makeMeaningHit(best, 0.9), makeMeaningHit(other, 0.1)]);

    const result = await runPipeline("task", {});

    expect(result.byMeaning.map((h) => h.experience.id)).toEqual(["best-and-oldest", "newer"]);
    expect(result.context.experiences.map((e) => e.experienceId)).toEqual(["newer", "best-and-oldest"]);
  });

  it("clamps its experience budget to buildContext's cap, so a relevance-ranked hit is never dropped by the recency sort", async () => {
    // The best-matching memory is also the OLDEST. With a budget above
    // buildContext's cap it would be sorted to the back and truncated away.
    const best = makeExperience("best-and-oldest", {
      lessons: ["the answer"],
      timestamp: "2019-01-01T00:00:00.000Z",
    });
    const filler = Array.from({ length: 12 }, (_, i) =>
      makeMeaningHit(
        makeExperience(`filler-${i}`, { timestamp: `2026-01-${String(i + 10)}T00:00:00.000Z` }),
        0.001
      )
    );
    mockQueryByMeaning.mockResolvedValue([makeMeaningHit(best, 0.5), ...filler]);

    const result = await runPipeline("task", { maxExperiences: 20 });

    expect(mockQueryByMeaning.mock.calls[0]?.[1]?.limit).toBe(10);
    expect(result.context.experiences.map((e) => e.experienceId)).toContain("best-and-oldest");
  });

  it("a caller-supplied byMeaning.limit cannot defeat the budget clamp", async () => {
    await runPipeline("task", { maxExperiences: 3, byMeaning: { limit: 500 } });

    expect(mockQueryByMeaning.mock.calls[0]?.[1]?.limit).toBe(3);
  });

  it("forwards the caller's other by-meaning options through untouched", async () => {
    await runPipeline("task", { byMeaning: { includeCold: true, legLimit: 7, session: "s1" } });

    expect(mockQueryByMeaning.mock.calls[0]?.[1]).toMatchObject({
      includeCold: true,
      legLimit: 7,
      session: "s1",
    });
  });

  it("reuses spec.md §22 step 1's single task embedding for the vector leg instead of embedding twice", async () => {
    const embed = vi.fn(async () => [0.1, 0.2, 0.3]);
    const embedder: EmbeddingProvider = { embed };

    await runPipeline("task", { embedder });

    expect(embed).toHaveBeenCalledTimes(1);
    expect(mockQueryByMeaning.mock.calls[0]?.[1]?.queryEmbedding).toEqual([0.1, 0.2, 0.3]);
  });

  it("runs lexical-only with no embedder, rather than failing or inventing one", async () => {
    await runPipeline("task", {});

    expect(mockQueryByMeaning.mock.calls[0]?.[1]?.queryEmbedding).toBeUndefined();
  });

  it("does no git work and tags nothing when stalenessRepoDir is omitted", async () => {
    mockQueryByMeaning.mockResolvedValue([makeMeaningHit(makeExperience("m"), 0.5)]);

    const result = await runPipeline("task", {});

    expect(result.staleness).toEqual([]);
    expect(result.context.experiences[0]?.staleness).toBeUndefined();
  });
});
