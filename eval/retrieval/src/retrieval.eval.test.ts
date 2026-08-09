import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, runMigrations } from "@cognitive-memory/graph-store";
import { createFakeEmbedder, indexNodeEmbeddings, retrieveSeeds } from "@cognitive-memory/retrieval";
import { RETRIEVAL_EVAL_CASES } from "./cases.js";
import { buildRetrievalFixture, type RetrievalFixture } from "./fixture.js";

// Same DATABASE_URL-gating convention as every other integration/eval suite
// in this repo — skipped, not failed, without a real Postgres.
const hasDb = Boolean(process.env["DATABASE_URL"]);
const d = hasDb ? describe : describe.skip;

d("retrieval eval set (spec.md §19 point 1 / ROADMAP.md M2)", () => {
  let fixture: RetrievalFixture;

  beforeAll(async () => {
    await runMigrations();
    fixture = await buildRetrievalFixture();
    await indexNodeEmbeddings(fixture.allNodes, createFakeEmbedder());
  });

  afterAll(async () => {
    await closePool();
  });

  it.each(RETRIEVAL_EVAL_CASES)(
    '[$kind] "$query" -> $expected',
    async ({ query, expected, kind }) => {
      const embedder = createFakeEmbedder();
      const seeds = await retrieveSeeds(query, { repoId: fixture.repoId, embedder });
      const expectedId = fixture.nodeIds[expected];

      expect(
        seeds.some((s) => s.nodeId === expectedId),
        `expected "${query}" (${kind}) to surface ${expected} in the seed set, got: ${JSON.stringify(
          seeds
        )}`
      ).toBe(true);
    }
  );
});
