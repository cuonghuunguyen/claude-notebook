/**
 * ROADMAP M13's retrieval acceptance, at the level a caller actually uses:
 * "superseded memories excluded from by-meaning retrieval; explicitly included
 * when asked for history" and "a supersede chain of length 3 returns only the
 * head".
 *
 * Exercised through `queryByMeaning` rather than the storage primitives (which
 * `graph-store/src/supersede.integration.test.ts` covers) because the fusion
 * step sits between the two, and "excluded from retrieval" is a claim about
 * what the fused list contains — an exclusion that the legs honoured but that
 * fusion re-introduced from a cached row would pass a storage-level test.
 *
 * `DATABASE_URL`-gated like every other integration suite in the repo.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getExperienceById, listEventsSince, useTemporaryDatabase } from "@cognitive-memory/graph-store";
import { queryByMeaning } from "./byMeaning.js";
import { recordExperience } from "./record.js";
import {
  currentMemory,
  memoryHistory,
  recordSupersedingExperience,
  recordVerification,
} from "./supersede.js";


const tag = randomUUID().slice(0, 8);
/** A nonsense word unique to this run, so the lexical legs can only find our rows. */
const TERM = `flimberwock${tag.replace(/[^a-z]/g, "")}`;
const QUESTION = `why does ${TERM} behave the way it does`;

async function ours(options: Parameters<typeof queryByMeaning>[1] = {}): Promise<string[]> {
  const hits = await queryByMeaning(QUESTION, { limit: 20, ...options });
  return hits.map((h) => h.experience.id).filter((id) => id.startsWith(tag));
}

let v1: string;
let v2: string;
let v3: string;

describe("read-repair through by-meaning retrieval (M13)", () => {
  beforeAll(async () => {
    await useTemporaryDatabase();

    const first = await recordExperience({
      id: `${tag}-v1`,
      task: `${TERM} behaviour`,
      observation: `${TERM} is handled by the first implementation`,
      relatedNodes: [`node-${tag}`],
      anchors: [{ path: `src/${tag}.ts`, symbol: "handler" }],
      confidence: 0.7,
      timestamp: "2026-01-01T00:00:00Z",
    });
    v1 = first.id;

    const second = await recordSupersedingExperience({
      id: `${tag}-v2`,
      supersedes: v1,
      task: `${TERM} behaviour`,
      observation: `${TERM} is handled by the second implementation`,
      // No `anchors`, no `relatedNodes`: both inherit from v1.
      confidence: 0.8,
      timestamp: "2026-02-01T00:00:00Z",
    });
    v2 = second.experience.id;

    const third = await recordSupersedingExperience({
      id: `${tag}-v3`,
      supersedes: v2,
      task: `${TERM} behaviour`,
      observation: `${TERM} is handled by the third implementation`,
      confidence: 0.9,
      timestamp: "2026-03-01T00:00:00Z",
    });
    v3 = third.experience.id;
  });

  afterAll(async () => {
    await closeDb();
  });

  it("returns only the head of a length-3 chain by default", async () => {
    expect(await ours()).toEqual([v3]);
  });

  it("returns the retracted memories too when history is explicitly asked for", async () => {
    const withHistory = await ours({ includeSuperseded: true });
    expect(withHistory).toEqual(expect.arrayContaining([v1, v2, v3]));
    expect(withHistory).toHaveLength(3);
  });

  it("orders one memory's history oldest-first, whichever member you hold", async () => {
    expect((await memoryHistory(v1)).map((e) => e.id)).toEqual([v1, v2, v3]);
    expect((await memoryHistory(v3)).map((e) => e.id)).toEqual([v1, v2, v3]);
  });

  it("resolves a remembered id forward to what replaced it", async () => {
    expect((await currentMemory(v1))?.id).toBe(v3);
  });

  it("inherits the superseded memory's anchors AND node bindings when the correction gives none", async () => {
    // A correction is about the same code by definition; losing the anchors
    // would make the correction itself invisible to the staleness pass that
    // surfaced its predecessor.
    const head = await getExperienceById(v3);
    expect(head?.anchors).toEqual([{ path: `src/${tag}.ts`, symbol: "handler" }]);
    expect(head?.relatedNodes).toEqual([`node-${tag}`]);
  });

  it("respects explicitly empty bindings instead of inheriting them", async () => {
    // Deliberately does NOT mention TERM: this pair must not become extra
    // answers to QUESTION, or the head-only assertions above would be
    // measuring this test's fixtures rather than the filter.
    const base = await recordExperience({
      id: `${tag}-anchored`,
      task: `${tag} anchored`,
      observation: `${tag} anchored original`,
      relatedNodes: [],
      anchors: [{ path: `src/${tag}-other.ts` }],
      confidence: 0.5,
      timestamp: "2026-01-01T00:00:00Z",
    });
    const corrected = await recordSupersedingExperience({
      id: `${tag}-unanchored`,
      supersedes: base.id,
      task: `${tag} anchored`,
      observation: `${tag} anchored correction`,
      // Both explicitly empty — "the caller said none", not "the caller did
      // not say". Distinguishable only because both fields are optional here.
      relatedNodes: [],
      anchors: [],
      confidence: 0.5,
      timestamp: "2026-02-01T00:00:00Z",
    });
    expect(corrected.experience.anchors).toEqual([]);
    expect(corrected.experience.relatedNodes).toEqual([]);
  });

  it("appends an ExperienceSuperseded event so a rebuild cannot resurrect the retracted memory", async () => {
    const events = await listEventsSince(0);
    const mine = events.filter(
      (e) =>
        e.eventType === "ExperienceSuperseded" &&
        (e.payload as { oldId?: string }).oldId === v1
    );
    expect(mine).toHaveLength(1);
    expect((mine[0]?.payload as { newId?: string }).newId).toBe(v2);
  });

  it("rolls the correction back with its link — never leaves two competing heads", async () => {
    await expect(
      recordSupersedingExperience({
        id: `${tag}-orphaned`,
        // v1 is already superseded by v2: the link half must fail, and the
        // correction half must not survive it. If it did, `${tag}-orphaned`
        // would be a second head answering the same question as v3.
        supersedes: v1,
        task: `${TERM} behaviour`,
        observation: `${TERM} would be an orphan`,
        relatedNodes: [],
        confidence: 0.5,
        timestamp: "2026-04-01T00:00:00Z",
      })
    ).rejects.toThrow(/already superseded/);

    expect(await getExperienceById(`${tag}-orphaned`)).toBeUndefined();
    expect(await ours()).toEqual([v3]);
  });

  it("refuses to correct a memory that does not exist", async () => {
    await expect(
      recordSupersedingExperience({
        supersedes: `${tag}-ghost`,
        task: "t",
        observation: "o",
        relatedNodes: [],
        confidence: 0.5,
      })
    ).rejects.toThrow(/no such experience/);
  });

  it("records a verification and reports a miss for an unknown id", async () => {
    expect(await recordVerification(v3, "2026-06-01T00:00:00Z")).toBe(true);
    expect((await getExperienceById(v3))?.verifiedAt).toBe(
      new Date("2026-06-01T00:00:00Z").toISOString()
    );
    expect(await recordVerification(`${tag}-ghost`)).toBe(false);
  });
});
