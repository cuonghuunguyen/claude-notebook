import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getDb, useDatabase } from "./db.js";
import { runMigrations } from "./migrate.js";
import {
  getExperienceById,
  markExperienceVerified,
  recordExperience,
  supersedeExperience,
} from "./experiences.js";
import { setExperienceWriterSession } from "./tiers.js";
import {
  SCOUT_ACTION_PREFIX,
  exportScoutReports,
  importScoutReports,
  relinkScoutSupersedes,
} from "./scoutTransfer.js";
import { useTemporaryDatabase } from "./testing.js";

/**
 * The one-shot scout-report transfer (spec.md §25.5 decision 2) — the single
 * exception to "there is no data-migration path".
 */
describe("scout-report export/import", () => {
  let source = "";

  beforeAll(async () => {
    source = await useTemporaryDatabase("cognitive-memory-scout");
  });

  afterAll(() => {
    closeDb();
  });

  const scoutReport = (id: string) => ({
    id,
    task: `worked out how the fusion weights interact ${id}`,
    observation:
      "The three legs are fused by rank, not by score, so a leg's scale cannot " +
      "move the fused result while its ordering holds.",
    action: `${SCOUT_ACTION_PREFIX} session-${id}`,
    lessons: ["RRF reads rank order, never the leg's score scale."],
    relatedNodes: ["packages/episodic/src/byMeaning.ts"],
    anchors: [{ path: "packages/episodic/src/byMeaning.ts", symbol: "fuseLegs" }],
    confidence: 0.7,
    timestamp: "2026-08-21T09:15:00.000Z",
  });

  it("exports only scout reports, not the mined commits that git can regenerate", async () => {
    const scout = await recordExperience(scoutReport(randomUUID()));
    await recordExperience({
      id: randomUUID(),
      task: "a mined commit",
      observation: "Reproducible from git, so deliberately not exported.",
      action: `commit ${randomUUID().slice(0, 8)}`,
      relatedNodes: [],
      confidence: 0.6,
      timestamp: "2026-08-20T09:15:00.000Z",
    });

    const payload = await exportScoutReports();
    expect(payload.version).toBe(2);
    expect(payload.experiences.map((experience) => experience.id)).toEqual([scout.id]);
    // Anchors survive as objects, not as the JSON text the column holds — the
    // export is the portable shape, not a row dump.
    expect(payload.experiences[0]?.anchors).toEqual([
      { path: "packages/episodic/src/byMeaning.ts", symbol: "fuseLegs" },
    ]);
  });

  it("imports into a fresh database, preserving the memory's own timestamp", async () => {
    const payload = await exportScoutReports();
    const original = payload.experiences[0];
    expect(original).toBeDefined();

    const target = await useTemporaryDatabase("cognitive-memory-scout-target");
    expect(target).not.toBe(source);

    expect(await importScoutReports(payload)).toEqual({ imported: 1, skipped: 0, relinked: 0, unlinkable: 0 });
    const restored = await getExperienceById(original?.id as string);
    // The write instant must NOT become the import instant: `timestamp` is what
    // §24.2.3 measures staleness from, so a re-stamped memory would look newer
    // than every commit that has since invalidated it.
    expect(restored?.timestamp).toBe("2026-08-21T09:15:00.000Z");
    expect(restored?.anchors).toEqual(original?.anchors);
    expect(restored?.lessons).toEqual(original?.lessons);

    // Re-running is safe rather than a primary-key error: the realistic way this
    // gets run twice is "the first run half-finished".
    expect(await importScoutReports(payload)).toEqual({ imported: 0, skipped: 1, relinked: 0, unlinkable: 0 });

    // No event is synthesized — see `importScoutReports` for why claiming these
    // reports were authored now would put a wrong `occurred_at` on the only
    // record of when a session actually worked something out.
    const { rows } = await getDb().query<{ n: number }>("SELECT count(*) AS n FROM events");
    expect(rows[0]?.n).toBe(0);
  });

  it("refuses a payload version it cannot read", async () => {
    await useDatabase(await useTemporaryDatabase("cognitive-memory-scout-version"));
    await runMigrations();
    await expect(
      importScoutReports({ version: 3, exportedAt: "", experiences: [] } as never)
    ).rejects.toThrow(/unsupported scout export version/);
  });

  it("carries a RETRACTED report across as retracted, not as a live head", async () => {
    // The failure this pins was found by a cold review pass and is the worst
    // shape this file can produce: a report that read-repair had withdrawn came
    // back as a chain head and answered by-meaning retrieval again — the graph
    // contradicting itself, on the one class of memory spec.md §25.5 says
    // nothing can regenerate. It is not a lost detail, it is restored knowledge
    // the system had decided was wrong.
    await useTemporaryDatabase("cognitive-memory-scout-chain");
    const oldId = "scout-retracted";
    const newId = "scout-correction";
    await recordExperience(scoutReport(oldId));
    await recordExperience(scoutReport(newId));
    await supersedeExperience(oldId, newId, { supersededAt: "2026-08-21T10:00:00.000Z" });
    await markExperienceVerified(newId, "2026-08-21T11:00:00.000Z");
    await setExperienceWriterSession(newId, "session-that-wrote-it");

    const payload = await exportScoutReports();
    expect(payload.experiences.map((experience) => experience.id).sort()).toEqual([
      newId,
      oldId,
    ]);

    await useTemporaryDatabase("cognitive-memory-scout-chain-target");
    expect(await importScoutReports(payload)).toEqual({
      imported: 2,
      skipped: 0,
      relinked: 1,
      unlinkable: 0,
    });

    // The retraction survived: the old report is not a head, the correction is.
    const retracted = await getExperienceById(oldId);
    expect(retracted?.supersededBy).toBe(newId);
    expect(retracted?.supersededAt).toBe("2026-08-21T10:00:00.000Z");
    const head = await getExperienceById(newId);
    expect(head?.supersededBy).toBeUndefined();

    // ...and so did the two pieces of state whose loss is silent rather than
    // loud: `verified_at`, without which the next staleness pass re-flags a
    // report a human already checked, and `writer_session`, without which
    // §24.5's no-self-promotion rule stops applying to the imported row.
    expect(head?.verifiedAt).toBe("2026-08-21T11:00:00.000Z");
    const { rows } = await getDb().query<{ writer_session: string | null }>(
      "SELECT writer_session FROM experiences WHERE id = $1",
      [newId]
    );
    expect(rows[0]?.writer_session).toBe("session-that-wrote-it");
  });

  it("restores a link whose target arrived separately, without duplicating an existing one", async () => {
    // A scout report can be retracted in favour of a MINED memory, which the
    // export omits on purpose (git regenerates it). If `sync` runs after the
    // import, pass 2 had nothing to point at; `relinkScoutSupersedes` is the
    // repair, and it must be idempotent because the realistic way it gets run
    // is "again, after sync".
    await useTemporaryDatabase("cognitive-memory-scout-relink");
    const oldId = "scout-awaiting";
    const minedId = "mined-correction";
    await recordExperience(scoutReport(oldId));
    await recordExperience({ ...scoutReport(minedId), action: "commit abc12345" });
    await supersedeExperience(oldId, minedId);
    const payload = await exportScoutReports();
    // Only the scout report travels; the mined correction is not in the export.
    expect(payload.experiences.map((experience) => experience.id)).toEqual([oldId]);

    await useTemporaryDatabase("cognitive-memory-scout-relink-target");
    const result = await importScoutReports(payload);
    expect(result.relinked).toBe(0);
    // Reported, not silently dropped: the caller has to know the report is a
    // live head again until `sync` + relink runs.
    expect(result.unlinkable).toBe(1);
    expect((await getExperienceById(oldId))?.supersededBy).toBeUndefined();

    // `sync` brings the mined memory back, and only then can the link be made.
    await recordExperience({ ...scoutReport(minedId), action: "commit abc12345" });
    expect(await relinkScoutSupersedes(payload)).toBe(1);
    expect((await getExperienceById(oldId))?.supersededBy).toBe(minedId);
    // Idempotent: re-running relinks nothing rather than throwing on a fork.
    expect(await relinkScoutSupersedes(payload)).toBe(0);
  });
});
