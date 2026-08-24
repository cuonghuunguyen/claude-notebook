import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getDb } from "./db.js";
import { runMigrations } from "./migrate.js";
import { useTemporaryDatabase } from "./testing.js";
import {
  listExperienceActions,
  recordExperience,
  searchExperiencesByEmbedding,
  searchExperiencesByFullText,
  searchExperiencesByTrigram,
  toFts5Match,
  upsertExperienceEmbedding,
} from "./experiences.js";

describe("experiences content search (spec.md §24.2.1 / ROADMAP.md M11)", () => {
  beforeAll(async () => {
    await useTemporaryDatabase();
  });

  afterAll(() => {
    closeDb();
  });

  it("the baseline creates the search surface the three legs need, and the runner is idempotent", async () => {
    // What this replaces is worth naming. Under Postgres the equivalent test
    // re-applied `0004_experiences_content_search.sql` twice by hand, because
    // that migration was written with `IF NOT EXISTS` on every statement and the
    // runner's applied-check would otherwise never exercise it. spec.md §25.5
    // decision 1 collapses the eight migrations into one baseline that runs on
    // an empty database, so "re-applying the file" is no longer a state anything
    // can reach — a second `CREATE TABLE experiences` is *supposed* to fail. The
    // contract that survives is the runner's, so that is what is asserted, plus
    // the existence of the surface the legs actually query.
    const objects = async (type: string): Promise<string[]> => {
      const { rows } = await getDb().query<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = $1 ORDER BY name`,
        [type]
      );
      return rows.map((row) => row.name);
    };

    expect(await objects("table")).toContain("experiences_fts");
    expect(await objects("trigger")).toEqual([
      "experiences_fts_delete",
      "experiences_fts_insert",
      "experiences_fts_update",
    ]);

    // `table_xinfo`, not `table_info`: the latter hides generated columns, and
    // `search_text` — the column FTS5's external content reads through — is one.
    const { rows: columns } = await getDb().query<{ name: string }>(
      `SELECT name FROM pragma_table_xinfo('experiences') ORDER BY name`
    );
    const names = columns.map((column) => column.name);
    expect(names).toContain("embedding");
    expect(names).toContain("search_text");

    // The runner already applied everything in `beforeAll`; a second run must
    // apply nothing rather than re-running a baseline that would throw.
    expect((await runMigrations()).applied).toEqual([]);
  });

  it("the FTS5 index follows a deleted memory out — what rebuild-from-events depends on", async () => {
    // External-content FTS5 does not know about a DELETE on its content table
    // unless a trigger tells it. If that link were broken, the full-text leg
    // would keep answering with memories that no longer exist — and
    // `wipeMaterializedGraph` deletes every row before a replay, so a rebuild
    // would leave the strongest leg pointing at a corpus that is gone.
    const marker = `fts${randomUUID().replace(/-/g, "")}`;
    const recorded = await recordExperience({
      id: randomUUID(),
      task: `${marker} temporary memory`,
      observation: `This memory exists only to be deleted, ${marker}.`,
      relatedNodes: [],
      confidence: 0.5,
      timestamp: new Date().toISOString(),
    });
    expect((await searchExperiencesByFullText(marker, 10)).map((hit) => hit.experience.id)).toEqual([
      recorded.id,
    ]);

    await getDb().query(`DELETE FROM experiences WHERE id = $1`, [recorded.id]);
    expect(await searchExperiencesByFullText(marker, 10)).toEqual([]);
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

  it("the full-text leg keeps OR-across-documents semantics: either term matches, ranked", async () => {
    // ROADMAP M17 names this explicitly, and it is the behaviour `byMeaning.ts`
    // is built on: a "why" question shares only a couple of content words with
    // the commit body that answers it, so the terms are OR-joined. Both
    // `plainto_tsquery` and `websearch_to_tsquery` AND their terms — and so does
    // FTS5 by default, which is why `toFts5Match` emits an explicit `OR`
    // between quoted terms rather than handing the term list straight to MATCH.
    //
    // The failure this guards against is silent and total: an AND would return
    // only documents containing every term, which on real questions is usually
    // none, so the strongest leg would go quiet rather than wrong.
    const marker = `orsem${randomUUID().replace(/-/g, "")}`;
    const both = await recordExperience({
      id: randomUUID(),
      task: `${marker} lookahead and anchors`,
      observation: `The ${marker} regex uses a lookahead, and the helper anchors it.`,
      relatedNodes: [],
      confidence: 0.7,
      timestamp: "2026-01-03T00:00:00.000Z",
    });
    const onlyFirst = await recordExperience({
      id: randomUUID(),
      task: `${marker} lookahead only`,
      observation: `The ${marker} regex uses a lookahead. Nothing else here.`,
      relatedNodes: [],
      confidence: 0.7,
      timestamp: "2026-01-02T00:00:00.000Z",
    });
    const onlySecond = await recordExperience({
      id: randomUUID(),
      task: `${marker} anchors only`,
      observation: `The ${marker} helper anchors the pattern. Nothing else here.`,
      relatedNodes: [],
      confidence: 0.7,
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    const hits = await searchExperiencesByFullText(`${marker} | lookahead | anchors`, 10);
    const ids = hits.map((hit) => hit.experience.id);
    // Either term is enough — a document with one of them is returned.
    expect(ids).toContain(onlyFirst.id);
    expect(ids).toContain(onlySecond.id);
    // ...and matching more of the question ranks higher, which is the half that
    // makes OR useful rather than merely permissive.
    expect(ids[0]).toBe(both.id);
  });

  it("translates the `|`-joined term list into an FTS5 MATCH expression, quoting each term", () => {
    // `toExperienceTsQuery`'s output format is deliberately unchanged by the port
    // (it is exported, and the eval harnesses reproduce the exact query the
    // shipped path builds), so the dialect translation lives here. Quoting is
    // what stops a term from being read as FTS5 syntax — `NEAR`, `AND` and `*`
    // are all operators — and what keeps an underscore-bearing term a phrase
    // rather than a syntax error under `unicode61`.
    expect(toFts5Match("alpha | beta")).toBe('"alpha" OR "beta"');
    expect(toFts5Match("solo")).toBe('"solo"');
    expect(toFts5Match("snake_case | near")).toBe('"snake_case" OR "near"');
    // An all-stopword question degrades to "no lexical hits" rather than throwing.
    expect(toFts5Match("")).toBe("");
    expect(toFts5Match(" | ")).toBe("");
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
