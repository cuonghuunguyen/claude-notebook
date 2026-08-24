/**
 * Supersede chains at the storage layer (spec.md §24.2 decision 4 / §24.6,
 * ROADMAP.md M13).
 *
 * The behaviour under test is entirely SQL — a partial predicate on every
 * experience query, two recursive walks, and three refusals — so it runs against
 * a real database rather than a mock. A mocked version of these assertions would
 * only be checking that this file and the implementation agree on a string.
 *
 * Each suite gets its own SQLite file (`useTemporaryDatabase`); there is no
 * connection string to configure and therefore nothing to skip on
 * (spec.md §25.4).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Experience } from "@cognitive-memory/core";
import { closeDb, withTransaction } from "./db.js";
import {
  getSupersedeHead,
  listSupersedeChain,
  markExperienceVerified,
  markExperiencesSuspect,
  queryExperiencesByTask,
  recordExperience,
  searchExperiencesByFullText,
  SupersedeError,
  supersedeExperience,
  getExperienceById,
} from "./experiences.js";
import { useTemporaryDatabase } from "./testing.js";


/** Unique per run so parallel vitest workers and re-runs never collide. */
const tag = randomUUID().slice(0, 8);
const TASK = `m13-chain-${tag}`;

/** A term unique to this run, so the full-text leg can only see our rows. */
const TERM = `zorblatt${tag.replace(/[^a-z]/g, "") || "x"}`;

function experience(id: string, observation: string, timestamp: string): Experience {
  return {
    id,
    task: TASK,
    observation,
    lessons: [],
    relatedNodes: [],
    anchors: [{ path: `src/${tag}.ts` }],
    confidence: 0.7,
    timestamp,
  };
}

const IDS = {
  v1: `${tag}-v1`,
  v2: `${tag}-v2`,
  v3: `${tag}-v3`,
  orphan: `${tag}-orphan`,
  loner: `${tag}-loner`,
  mergeA: `${tag}-merge-a`,
  mergeB: `${tag}-merge-b`,
  mergeHead: `${tag}-merge-head`,
};

describe("supersede chains (M13)", () => {
  beforeAll(async () => {
    await useTemporaryDatabase();
    // A three-link chain: v1 <- v2 <- v3. All three say TERM, so all three are
    // reachable by the same query and only the filter can tell them apart.
    await recordExperience(experience(IDS.v1, `${TERM} first answer`, "2026-01-01T00:00:00Z"));
    await recordExperience(experience(IDS.v2, `${TERM} second answer`, "2026-02-01T00:00:00Z"));
    await recordExperience(experience(IDS.v3, `${TERM} third answer`, "2026-03-01T00:00:00Z"));
    await recordExperience(experience(IDS.orphan, `${TERM} unrelated answer`, "2026-04-01T00:00:00Z"));
    await recordExperience(experience(IDS.loner, `${TERM} lone answer`, "2026-05-01T00:00:00Z"));
    await supersedeExperience(IDS.v1, IDS.v2);
    await supersedeExperience(IDS.v2, IDS.v3);

    // A MERGE: two separate memories retracted in favour of the same
    // correction. Legal — the link is single-valued, so chains cannot fork
    // forward, but two of them can converge.
    await recordExperience(experience(IDS.mergeA, "merge branch a", "2026-01-01T00:00:00Z"));
    await recordExperience(experience(IDS.mergeB, "merge branch b", "2026-01-02T00:00:00Z"));
    await recordExperience(experience(IDS.mergeHead, "merge head", "2026-02-01T00:00:00Z"));
    await supersedeExperience(IDS.mergeA, IDS.mergeHead);
    await supersedeExperience(IDS.mergeB, IDS.mergeHead);
  });

  afterAll(() => {
    closeDb();
  });

  // --- ROADMAP M13 acceptance: "supersede chain of length 3 returns only the head"

  it("returns only the chain head from full-text retrieval — a chain of 3 yields 1", async () => {
    const hits = await searchExperiencesByFullText(TERM, 20);
    const ours = hits.map((h) => h.experience.id).filter((id) => id.startsWith(tag));
    expect(ours).toContain(IDS.v3);
    expect(ours).not.toContain(IDS.v1);
    expect(ours).not.toContain(IDS.v2);
    // The two memories that were never superseded are untouched by the filter.
    expect(ours).toContain(IDS.orphan);
    expect(ours).toContain(IDS.loner);
  });

  it("returns the whole chain when history is explicitly asked for", async () => {
    const hits = await searchExperiencesByFullText(TERM, 20, { includeSuperseded: true });
    const ours = hits.map((h) => h.experience.id).filter((id) => id.startsWith(tag));
    expect(ours).toEqual(expect.arrayContaining([IDS.v1, IDS.v2, IDS.v3]));
  });

  it("applies the same default to by-task retrieval, not just the search legs", async () => {
    const heads = await queryExperiencesByTask(TASK);
    expect(heads.map((e) => e.id)).not.toContain(IDS.v1);
    expect(heads.map((e) => e.id)).toContain(IDS.v3);

    const all = await queryExperiencesByTask(TASK, { includeSuperseded: true });
    expect(all.map((e) => e.id)).toEqual(expect.arrayContaining([IDS.v1, IDS.v2, IDS.v3]));
  });

  // --- chain reads

  it("lists the chain oldest-first from ANY member, not just the head", async () => {
    for (const from of [IDS.v1, IDS.v2, IDS.v3]) {
      const chain = await listSupersedeChain(from);
      expect(chain.map((e) => e.id)).toEqual([IDS.v1, IDS.v2, IDS.v3]);
    }
  });

  it("shows every branch of a merged chain, from any member — not just from the head", async () => {
    // The failure this pins: walking back only from the requested id returns
    // [mergeA, mergeHead] and hides that mergeB was retracted by the same
    // correction — so `memoryHistory(mergeA)` would under-report the history.
    const expected = [IDS.mergeA, IDS.mergeB, IDS.mergeHead];
    for (const from of expected) {
      expect((await listSupersedeChain(from)).map((e) => e.id)).toEqual(expected);
    }
  });

  it("returns only the merge head from default retrieval", async () => {
    const heads = (await queryExperiencesByTask(TASK)).map((e) => e.id);
    expect(heads).toContain(IDS.mergeHead);
    expect(heads).not.toContain(IDS.mergeA);
    expect(heads).not.toContain(IDS.mergeB);
  });

  it("lists a single-element chain for a memory nothing has replaced", async () => {
    const chain = await listSupersedeChain(IDS.loner);
    expect(chain.map((e) => e.id)).toEqual([IDS.loner]);
  });

  it("returns an empty chain for an unknown id rather than throwing", async () => {
    expect(await listSupersedeChain(`${tag}-nope`)).toEqual([]);
  });

  it("resolves a remembered id forward to the current answer", async () => {
    expect((await getSupersedeHead(IDS.v1))?.id).toBe(IDS.v3);
    expect((await getSupersedeHead(IDS.v3))?.id).toBe(IDS.v3);
    expect((await getSupersedeHead(IDS.loner))?.id).toBe(IDS.loner);
    expect(await getSupersedeHead(`${tag}-nope`)).toBeUndefined();
  });

  it("carries the link onto the retracted memory's own shape", async () => {
    const v1 = await getExperienceById(IDS.v1);
    expect(v1?.supersededBy).toBe(IDS.v2);
    expect(v1?.supersededAt).toBeTruthy();
    const v3 = await getExperienceById(IDS.v3);
    expect(v3?.supersededBy).toBeUndefined();
  });

  // --- refusals: the shapes that would silently destroy knowledge

  it("refuses a self-supersede", async () => {
    await expect(supersedeExperience(IDS.loner, IDS.loner)).rejects.toThrow(SupersedeError);
    // ...and the memory is still retrievable.
    expect((await getExperienceById(IDS.loner))?.supersededBy).toBeUndefined();
  });

  it("refuses a fork — re-pointing an already-superseded memory at someone else", async () => {
    await expect(supersedeExperience(IDS.v1, IDS.orphan)).rejects.toThrow(/already superseded/);
    expect((await getExperienceById(IDS.v1))?.supersededBy).toBe(IDS.v2);
  });

  it("is idempotent when the link already points at the same successor", async () => {
    const result = await supersedeExperience(IDS.v1, IDS.v2);
    expect(result.linked).toBe(false);
    expect((await getExperienceById(IDS.v1))?.supersededBy).toBe(IDS.v2);
  });

  it("refuses a cycle — the head cannot be superseded by its own ancestor", async () => {
    // v3 -> v1 would close v1 -> v2 -> v3 -> v1, making every member of the
    // chain fail `superseded_by IS NULL`: the whole chain would vanish.
    await expect(supersedeExperience(IDS.v3, IDS.v1)).rejects.toThrow(/cycle/);
    expect((await getExperienceById(IDS.v3))?.supersededBy).toBeUndefined();
    const stillReachable = await searchExperiencesByFullText(TERM, 20);
    expect(stillReachable.map((h) => h.experience.id)).toContain(IDS.v3);
  });

  it("refuses to link a memory that does not exist", async () => {
    await expect(supersedeExperience(`${tag}-ghost`, IDS.loner)).rejects.toThrow(/no such experience/);
    await expect(supersedeExperience(IDS.loner, `${tag}-ghost`)).rejects.toThrow(
      /no such superseding experience/
    );
  });

  // --- verification

  it("markExperienceVerified clears the doubt and stamps when the check happened", async () => {
    await markExperiencesSuspect([{ id: IDS.loner, reason: "modified src/x.ts in deadbeef" }]);
    expect((await getExperienceById(IDS.loner))?.suspect).toBe(true);

    const at = "2026-07-01T00:00:00Z";
    expect(await markExperienceVerified(IDS.loner, at)).toBe(true);
    const after = await getExperienceById(IDS.loner);
    expect(after?.suspect).toBe(false);
    expect(after?.suspectReason).toBeUndefined();
    expect(after?.verifiedAt).toBe(new Date(at).toISOString());
  });

  it("clears the retired memory's suspect mark — the doubt has been answered (ROADMAP M13)", async () => {
    await markExperiencesSuspect([{ id: IDS.orphan, reason: "modified src/x.ts in deadbeef" }]);
    expect((await getExperienceById(IDS.orphan))?.suspect).toBe(true);

    await recordExperience(experience(`${tag}-fix`, "the correction", "2026-06-01T00:00:00Z"));
    await supersedeExperience(IDS.orphan, `${tag}-fix`);

    const retired = await getExperienceById(IDS.orphan);
    expect(retired?.suspect).toBe(false);
    expect(retired?.suspectReason).toBeUndefined();
    expect(retired?.supersededBy).toBe(`${tag}-fix`);
  });

  it("serializes concurrent supersedes so two of them cannot close a cycle", async () => {
    // `supersede(X, Y)` and `supersede(Y, X)` issued together, with the
    // interleaving FORCED rather than raced — the first runs in a transaction
    // this test holds open, which is exactly the window the second must not be
    // allowed to read through — so this is not a timing lottery.
    //
    // Honest about what it proves. Under Postgres this pinned the outcome of a
    // transaction-scoped advisory lock, and the note in `supersedeExperience`
    // records that removing that lock did not make the test fail — the foreign
    // key's implicit `FOR KEY SHARE` lock deadlocked the pair instead, so the
    // difference the lock bought was a specific refusal rather than an opaque
    // `deadlock detected`.
    //
    // spec.md §25.4 deletes both locks, so what serializes this now is SQLite's
    // single write lock plus `withTransaction`'s in-process queue (`db.ts`). The
    // assertion is unchanged and that is the point: the second caller waits
    // rather than reading through the open window, no cycle exists afterwards,
    // one memory is still a head, and the loser gets the cycle refusal by name.
    //
    // Removing the queue DOES make this fail, which is what makes it a test of
    // the new mechanism rather than of the engine: two concurrent transactions
    // on one connection would interleave their statements between BEGIN and
    // COMMIT.
    const x = `${tag}-race-x`;
    const y = `${tag}-race-y`;
    await recordExperience(experience(x, "race x", "2026-01-01T00:00:00Z"));
    await recordExperience(experience(y, "race y", "2026-01-02T00:00:00Z"));

    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    // The first supersede runs inside a transaction held open until `release`.
    const first = withTransaction(async (tx) => {
      await supersedeExperience(x, y, { db: tx });
      await held;
    });

    // Started from OUTSIDE that transaction's async context on purpose:
    // `withTransaction` refuses to nest, and a call made from inside the
    // callback would be a nesting error rather than a queued competitor.
    let settled = false;
    const second = supersedeExperience(y, x);
    second.then(
      () => (settled = true),
      () => (settled = true)
    );

    // While the first transaction is open the second cannot proceed at all.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(settled).toBe(false);

    release();
    await first;

    // Once the first commits, the second can see the link and refuses.
    await expect(second).rejects.toThrow(/cycle/);
    expect((await getExperienceById(x))?.supersededBy).toBe(y);
    expect((await getExperienceById(y))?.supersededBy).toBeUndefined();
  });

  it("reports a miss for an unknown id instead of silently succeeding", async () => {
    expect(await markExperienceVerified(`${tag}-ghost`)).toBe(false);
  });
});
