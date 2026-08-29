/**
 * spec.md §26 / ROADMAP.md M19. Real SQLite, throwaway file per suite, fake
 * runner — the LLM is injected precisely so the pass is testable without one.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { queryByMeaning, recordExperience } from "@cognitive-memory/episodic";
import { closeDb, getDb, upsertExperienceEmbedding, useTemporaryDatabase } from "@cognitive-memory/graph-store";
import { distillExperiences } from "./distill.js";

/** A token no other suite's rows can contain, so retrieval assertions are unambiguous. */
const MARKER = `dst${randomUUID().replace(/-/g, "")}`;

async function embeddingOf(id: string): Promise<Buffer | null> {
  const { rows } = await getDb().query<{ embedding: Buffer | null }>(
    "SELECT embedding FROM experiences WHERE id = $1",
    [id]
  );
  return rows[0]?.embedding ?? null;
}

async function digestOf(id: string): Promise<string | null> {
  const { rows } = await getDb().query<{ digest: string | null }>(
    "SELECT digest FROM experiences WHERE id = $1",
    [id]
  );
  return rows[0]?.digest ?? null;
}

function record(observation: string) {
  return recordExperience({
    task: `${MARKER} subject`,
    observation,
    relatedNodes: ["src/a.ts"],
    anchors: [{ path: "src/a.ts" }],
    confidence: 0.7,
  });
}

describe("distillExperiences", () => {
  beforeAll(async () => {
    await useTemporaryDatabase("capture-distill");
    return () => closeDb();
  });

  it("writes the digest and drops the embedding so the backfill re-embeds from it", async () => {
    const saved = await record(`${MARKER} the raw commit body, at length`);
    await upsertExperienceEmbedding(saved.id, new Array(1536).fill(0.1));
    expect(await embeddingOf(saved.id)).not.toBeNull();

    const prompts: string[] = [];
    const result = await distillExperiences({
      runner: async (prompt) => {
        prompts.push(prompt);
        return `What: a change.\nWhy: a reason.\nWhere: src/a.ts`;
      },
    });

    expect(result).toEqual({ distilled: 1, skipped: 0 });
    expect(await digestOf(saved.id)).toContain("What: a change.");
    expect(await embeddingOf(saved.id)).toBeNull();
    // The prompt carries the body and the anchor paths, or the runner cannot
    // produce a `Where:` line that names real files.
    expect(prompts[0]).toContain(`${MARKER} the raw commit body`);
    expect(prompts[0]).toContain("src/a.ts");
  });

  it("skips empty and oversized runner output, leaving the digest NULL for the next pass", async () => {
    const empty = await record(`${MARKER} body whose runner returns nothing`);
    const huge = await record(`${MARKER} body whose runner returns an essay`);

    const result = await distillExperiences({
      runner: async (prompt) => (prompt.includes("returns nothing") ? "   " : "x".repeat(1201)),
    });

    expect(result).toEqual({ distilled: 0, skipped: 2 });
    expect(await digestOf(empty.id)).toBeNull();
    expect(await digestOf(huge.id)).toBeNull();
  });

  it("is idempotent: a second pass re-runs only what is still undistilled", async () => {
    const calls: string[] = [];
    const runner = async (prompt: string) => {
      calls.push(prompt);
      return "What: x.\nWhy: y.\nWhere: src/a.ts";
    };

    // Concurrency 1 so `calls` order is deterministic; the pass itself defaults to 4.
    const first = await distillExperiences({ runner, concurrency: 1 });
    // The two rows the previous case skipped are exactly the pending worklist.
    expect(first).toEqual({ distilled: 2, skipped: 0 });

    calls.length = 0;
    const second = await distillExperiences({ runner, concurrency: 1 });
    expect(second).toEqual({ distilled: 0, skipped: 0 });
    expect(calls).toHaveLength(0);
  });

  it("retrieves a distilled memory by a term that appears only in its digest", async () => {
    // Deliberately NOT prefixed with MARKER: the trigram leg would match the
    // shared prefix on every other row in this suite's database and the
    // "invisible before distillation" half of the assertion would be vacuous.
    const term = "quorvaxinite";
    const saved = await record(`${MARKER} a body that never mentions the digest-only term`);

    expect(await queryByMeaning(term)).toHaveLength(0);

    await distillExperiences({
      runner: async () => `What: ${term} was introduced.\nWhy: to test it.\nWhere: src/a.ts`,
    });

    const hits = await queryByMeaning(term);
    expect(hits.map((h) => h.experience.id)).toContain(saved.id);
    expect(hits[0]?.experience.digest).toContain(term);
  });
});
