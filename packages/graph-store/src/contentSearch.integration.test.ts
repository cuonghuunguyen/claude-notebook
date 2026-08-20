import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "./db.js";
import { runMigrations } from "./migrate.js";
import {
  listExperienceActions,
  recordExperience,
  searchExperiencesByEmbedding,
  searchExperiencesByFullText,
  searchExperiencesByTrigram,
  upsertExperienceEmbedding,
} from "./experiences.js";

// Same DATABASE_URL-gating convention as every other integration suite in
// this repo — skipped, not failed, without a real Postgres.
const hasDb = Boolean(process.env["DATABASE_URL"]);
const d = hasDb ? describe : describe.skip;

// src/ -> packages/graph-store -> repo root -> migrations/
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "migrations");
const CONTENT_SEARCH_MIGRATION = "0004_experiences_content_search.sql";

d("experiences content search (spec.md §24.2.1 / ROADMAP.md M11)", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await closePool();
  });

  it(`${CONTENT_SEARCH_MIGRATION} applies twice cleanly, on its own and through the runner`, async () => {
    const sql = readFileSync(join(migrationsDir, CONTENT_SEARCH_MIGRATION), "utf-8");
    const indexNames = async (): Promise<string[]> => {
      const { rows } = await getPool().query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'experiences' ORDER BY indexname`
      );
      return rows.map((r) => r.indexname);
    };
    const columns = async (): Promise<string[]> => {
      const { rows } = await getPool().query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'experiences' ORDER BY column_name`
      );
      return rows.map((r) => r.column_name);
    };

    // The runner skips already-applied files by name, so re-applying the raw
    // SQL is the only way to prove the migration itself is re-runnable — which
    // matters the moment anyone restores a dump or a branch applies it out of
    // order. Both `await`s must not throw: that is the actual assertion.
    const before = { indexes: await indexNames(), columns: await columns() };
    await getPool().query(sql);
    await getPool().query(sql);

    // Everything the migration creates is present, and applying it twice more
    // changed nothing — not one extra index, not one extra column.
    expect(before.indexes).toContain("experiences_embedding_hnsw_idx");
    expect(before.indexes).toContain("experiences_text_fts_idx");
    expect(before.indexes).toContain("experiences_text_trgm_idx");
    expect(before.columns).toContain("embedding");
    expect(await indexNames()).toEqual(before.indexes);
    expect(await columns()).toEqual(before.columns);
  });

  it("the full-text leg ranks by how much of the question a memory's text answers", async () => {
    const marker = randomUUID().replace(/-/g, "");
    const strong = await recordExperience(
      {
        id: randomUUID(),
        task: `${marker} tuple minItems derives from an optin walk`,
        observation:
          `In the JSON Schema tuple processor the ${marker} minItems bound is derived by ` +
          `walking each prefix item's optin/optout state rather than taking ` +
          `prefixItems.length, because a trailing optional or defaulted item would ` +
          `otherwise overcount and the schema would reject valid short tuples.`,
        relatedNodes: [],
        confidence: 0.7,
        timestamp: new Date().toISOString(),
      }
    );
    const weak = await recordExperience({
      id: randomUUID(),
      task: `${marker} unrelated tuple rename`,
      observation: `Renamed a local variable in the ${marker} tuple file. No behaviour change.`,
      relatedNodes: [],
      confidence: 0.7,
      timestamp: new Date().toISOString(),
    });

    const hits = await searchExperiencesByFullText(
      `${marker} | minitems | prefixitems | optional | overcount`,
      10
    );
    const ids = hits.map((h) => h.experience.id);
    expect(ids).toContain(strong.id);
    expect(ids.indexOf(strong.id)).toBeLessThan(
      ids.includes(weak.id) ? ids.indexOf(weak.id) : Number.MAX_SAFE_INTEGER
    );
    expect(hits[0]?.score).toBeGreaterThan(0);
  });

  it("the trigram leg matches an identifier fragment inside a long body, which whole-string similarity never would", async () => {
    const marker = `Zed${randomUUID().replace(/-/g, "").slice(0, 8)}Catch`;
    const recorded = await recordExperience({
      id: randomUUID(),
      task: "catch optin is unconditional",
      observation:
        `${marker} is marked optin === "optional" unconditionally, which restores the ` +
        `pre-4.4 behaviour where an absent key still runs the catch. Tightening it in ` +
        `4.4 made a schema reject input it had always accepted, so it was reverted.`,
      relatedNodes: [],
      confidence: 0.7,
      timestamp: new Date().toISOString(),
    });

    const hits = await searchExperiencesByTrigram(marker, 10, 0.6);
    expect(hits.map((h) => h.experience.id)).toContain(recorded.id);
  });

  it("the vector leg only sees rows that actually have an embedding", async () => {
    const embedding = Array.from({ length: 1536 }, (_, i) => (i === 7 ? 1 : 0));
    const withVector = await recordExperience({
      id: randomUUID(),
      task: `vector-leg-${randomUUID()}`,
      observation: "This memory has an embedding.",
      relatedNodes: [],
      confidence: 0.7,
      timestamp: new Date().toISOString(),
    });
    const withoutVector = await recordExperience({
      id: randomUUID(),
      task: `vector-leg-${randomUUID()}`,
      observation: "This memory has no embedding and must never appear in the vector leg.",
      relatedNodes: [],
      confidence: 0.7,
      timestamp: new Date().toISOString(),
    });
    await upsertExperienceEmbedding(withVector.id, embedding);

    const ids = (await searchExperiencesByEmbedding(embedding, 50)).map((h) => h.experience.id);
    expect(ids).toContain(withVector.id);
    expect(ids).not.toContain(withoutVector.id);
  });

  it("listExperienceActions returns distinct actions under a prefix — the capture idempotency lookup", async () => {
    const prefix = `probe-${randomUUID().replace(/-/g, "")} `;
    for (const suffix of ["aaa", "aaa", "bbb"]) {
      await recordExperience({
        id: randomUUID(),
        task: "prefix probe",
        observation: "Recorded twice under the same action on purpose.",
        action: `${prefix}${suffix}`,
        relatedNodes: [],
        confidence: 0.7,
        timestamp: new Date().toISOString(),
      });
    }
    const actions = await listExperienceActions(prefix);
    expect(actions.sort()).toEqual([`${prefix}aaa`, `${prefix}bbb`]);
  });
});
