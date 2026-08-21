import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "./db.js";
import { runMigrations } from "./migrate.js";
import {
  queryExperiencesByTask,
  recordExperience,
  supersedeExperience,
} from "./experiences.js";
import { appendEvent, listEventsSince, type MemoryEvent } from "./events.js";
import { isRetiredEventType, replayEvents, wipeMaterializedGraph } from "./materializer.js";

// Integration tests only run against a real Postgres — set DATABASE_URL to
// enable them locally / in CI. They're skipped (not failed) otherwise, per
// ROADMAP.md M0/M1 acceptance criteria.
const hasDb = Boolean(process.env["DATABASE_URL"]);
const d = hasDb ? describe : describe.skip;

d("graph-store integration", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await closePool();
  });

  it("migrations are idempotent", async () => {
    const first = await runMigrations();
    expect(first.applied).toEqual([]); // already applied in beforeAll
  });

  it("the structural graph's tables are gone (migration 0008)", async () => {
    const { rows } = await getPool().query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN ('nodes', 'edges')`
    );
    expect(rows).toEqual([]);
  });

  it("records an append-only experience and queries it back", async () => {
    const task = `Fix duplicate payment events ${randomUUID()}`;
    const experienceId = randomUUID();

    await recordExperience({
      id: experienceId,
      task,
      observation: "Events were emitted before transaction completion.",
      action: "Moved event publication behind the transaction boundary.",
      result: "Duplicate events disappeared.",
      lessons: ["Payment events must not be emitted before transaction commit."],
      relatedNodes: ["src/payments/publish.ts"],
      confidence: 0.8,
      timestamp: new Date().toISOString(),
    });

    const found = await queryExperiencesByTask(task);
    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe(experienceId);
    expect(found[0]?.relatedNodes).toEqual(["src/payments/publish.ts"]);
  });

  it("appends events and lists them since a given id", async () => {
    const task = `event-test-${randomUUID()}`;
    const experience = {
      id: randomUUID(),
      task,
      observation: "something happened",
      relatedNodes: ["src/a.ts"],
      confidence: 0.5,
      timestamp: new Date().toISOString(),
    };

    const before = await appendEvent({ eventType: "ExperienceRecorded", payload: { experience } });
    await appendEvent({ eventType: "ExperienceRecorded", payload: { experience } });

    const since = await listEventsSince(before.id!);
    expect(since.length).toBeGreaterThanOrEqual(1);
    expect(since.every((e) => e.id! > before.id!)).toBe(true);
  });

  it("counts an event type from a newer build as unrecognised, not as a retired projection", async () => {
    // The cross-version case: a database migrated by a NEWER build carries an
    // event type this build has no case for. It cannot be reached through
    // `appendEvent` from here — `events_event_type_check` (migration 0007)
    // enumerates the §14 vocabulary at the schema level, so inserting one would
    // be rejected — which is precisely why it is exercised against
    // `replayEvents` directly rather than through the log.
    //
    // The distinction matters because `skipped` is documented as expected and
    // benign. An unknown type is not: it means the rebuild dropped a projection
    // nobody decided to drop.
    const result = await replayEvents([
      { eventType: "SomeFutureProjection" as MemoryEvent["eventType"], payload: {} },
    ]);

    expect(result).toEqual({ applied: 0, skipped: 0, unrecognised: 1 });
    // ...and it does not throw: a rebuild that refuses to finish because one
    // row is from the future turns a partial recovery into no recovery.
  });

  it("smoke-checks the pool is reachable", async () => {
    const pool = getPool();
    const { rows } = await pool.query("SELECT 1 as one");
    expect(rows[0]?.one).toBe(1);
  });

  // Last in the file deliberately: wipeMaterializedGraph/rebuildFromEvents
  // TRUNCATEs experiences for the whole database, not just this test's own
  // rows. Every `it` above already ran and asserted before this one starts
  // (vitest runs one file's `it`s in declaration order), so wiping here
  // doesn't retroactively break them. Safe with respect to OTHER packages'
  // test suites too: pnpm's topological script ordering means no package that
  // depends on graph-store starts its own test script until this entire file
  // has finished, so nothing else is touching the shared Postgres instance
  // while this runs.
  it("rebuild-from-events: wiping the materialized memory and replaying the event log reproduces the same state (spec.md §14)", async () => {
    // Scoped to this test's OWN events (from this point forward), not
    // `rebuildFromEvents()`'s full `listEventsSince(0)` — the events table
    // is shared across every suite that has ever run against this
    // database, and this test only controls the well-formedness of its own
    // contribution to it, not every fixture any other package's tests have
    // ever written. `wipeMaterializedGraph` + a scoped `replayEvents` still
    // exercises the exact same wipe-then-replay mechanism
    // `rebuildFromEvents` uses internally.
    const replayFromId = (await listEventsSince(0)).at(-1)?.id ?? 0;

    const task = `rebuild-test-${randomUUID()}`;
    const now = new Date().toISOString();

    // A pre-M15 structural event, replayed alongside the memory events.
    //
    // This is the case M15 had to keep working rather than the case it
    // removed: every database that ever ran an extraction has thousands of
    // these in its append-only log, so a replay that threw on one would be a
    // replay that fails on exactly the databases a rebuild exists for. The
    // projection is gone; accepting and counting the event is not.
    await appendEvent({
      eventType: "SymbolAdded",
      // A real §3.2 node id — sha256("repo\0src/parse.ts#parseAnchor") truncated
      // to 32 hex chars, as the generator M15 deleted produced them.
      payload: { node: { id: "4f82b9813f16ef750be0145a4f2755d8" }, repoId: "retired-repo" },
    });

    const experience = await recordExperience({
      id: randomUUID(),
      task,
      observation: "A calls B and B's behavior changed",
      relatedNodes: ["src/a.ts", "src/b.ts"],
      confidence: 0.6,
      timestamp: now,
    });
    await appendEvent({ eventType: "ExperienceRecorded", payload: { experience } });

    // A correction that retracts it (spec.md §24.6 / M13). This is the case
    // that forced `ExperienceSuperseded` into §14's event vocabulary: a replay
    // that could not reconstruct the link would put a memory the system has
    // WITHDRAWN back into the default retrieval path — the rebuilt graph would
    // answer with retracted knowledge, not merely lose metadata.
    const correction = await recordExperience({
      id: randomUUID(),
      task,
      observation: "Correction: B's behavior changed back",
      relatedNodes: ["src/a.ts", "src/b.ts"],
      confidence: 0.8,
      timestamp: now,
    });
    await appendEvent({ eventType: "ExperienceRecorded", payload: { experience: correction } });
    const link = await supersedeExperience(experience.id, correction.id);
    await appendEvent({
      eventType: "ExperienceSuperseded",
      payload: {
        oldId: experience.id,
        newId: correction.id,
        supersededAt: link.supersededAt,
      },
    });

    const preExperiences = (
      await queryExperiencesByTask(task, { includeCold: true, includeSuperseded: true })
    ).map((e) => ({ ...e, timestamp: undefined, supersededAt: undefined }));
    const preHeads = (await queryExperiencesByTask(task, { includeCold: true })).map((e) => e.id);

    await wipeMaterializedGraph();
    const events = await listEventsSince(replayFromId);
    const result = await replayEvents(events);

    const postExperiences = (
      await queryExperiencesByTask(task, { includeCold: true, includeSuperseded: true })
    ).map((e) => ({ ...e, timestamp: undefined, supersededAt: undefined }));
    const postHeads = (await queryExperiencesByTask(task, { includeCold: true })).map((e) => e.id);

    expect(postExperiences).toEqual(preExperiences);
    expect(postExperiences).toHaveLength(2);
    // The supersede link came back with them: the retracted memory is still
    // out of the default path after the rebuild, not resurrected by it.
    expect(postHeads).toEqual(preHeads);
    expect(postHeads).toContain(correction.id);
    expect(postHeads).not.toContain(experience.id);
    // The retired structural event was counted as skipped, not applied and not
    // thrown on — a caller can see the rebuild dropped a projection.
    expect(result.applied).toBe(3);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(isRetiredEventType("SymbolAdded")).toBe(true);
    expect(isRetiredEventType("ExperienceRecorded")).toBe(false);
    // And nothing was merely *unrecognised* — a retired projection and an event
    // type from a newer build are counted apart on purpose, so that a genuine
    // incomplete replay cannot hide inside the expected number.
    expect(result.unrecognised).toBe(0);
  });
});
