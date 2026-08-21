/**
 * ROADMAP M12's integration acceptance: "sync over a fixture repo's history
 * marks exactly the memories anchored to the changed files as suspect."
 *
 * "Exactly" is the load-bearing word, so this suite asserts both halves — the
 * memories that MUST be flagged, and the ones that must NOT be. A staleness
 * pass that flags everything is as useless as one that flags nothing, and only
 * the negative assertions can tell those apart.
 *
 * `DATABASE_URL`-gated like every other integration suite in the repo.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Anchor, Experience } from "@cognitive-memory/core";
import {
  clearExperienceSuspect,
  closePool,
  getPool,
  markExperienceVerified,
  getExperienceById,
  listExperiencesByAnchorPaths,
  recordExperience,
  runMigrations,
} from "@cognitive-memory/graph-store";
import { bulkyContent, buildFixtureRepo, type FixtureRepo } from "./fixtureRepo.js";
import { flagPossiblyStale, markSuspectFromHistory } from "./memoryStaleness.js";

/**
 * Un-stamps a verification. Not a graph-store export on purpose — nothing in
 * the system should be able to un-verify a memory (that is what a *new* commit
 * does, through the ordinary staleness test). It exists here only so this
 * suite's fixtures survive test order.
 */
async function clearVerification(id: string): Promise<void> {
  await getPool().query(`UPDATE experiences SET verified_at = NULL WHERE id = $1`, [id]);
}

const hasDb = Boolean(process.env["DATABASE_URL"]);
const d = hasDb ? describe : describe.skip;

const DATES = {
  init: "2026-01-01T00:00:00Z",
  memories: "2026-01-15T00:00:00Z",
  editTouched: "2026-02-01T00:00:00Z",
  rename: "2026-03-01T00:00:00Z",
  editRenamed: "2026-04-01T00:00:00Z",
  /** Authored after the memories... */
  skewedAuthor: "2026-05-01T00:00:00Z",
  /** ...but committed before them. */
  skewedCommitter: "2025-06-01T00:00:00Z",
};

/** After every commit in the fixture — a memory dated here cannot be stale. */
const AFTER_ALL_COMMITS = "2026-06-01T00:00:00Z";

let repo: FixtureRepo;

/** Unique per run so parallel vitest workers and re-runs never collide. */
const tag = randomUUID().slice(0, 8);

interface Fixture {
  id: string;
  anchors: Anchor[];
  timestamp: string;
  relatedNodes?: string[];
}

const IDS = {
  touched: `m12-touched-${tag}`,
  renamed: `m12-renamed-${tag}`,
  untouched: `m12-untouched-${tag}`,
  newerThanHistory: `m12-newer-${tag}`,
  unanchored: `m12-unanchored-${tag}`,
  symbolAnchored: `m12-symbol-${tag}`,
  legacyRelatedNodes: `m12-legacy-${tag}`,
  skewed: `m12-skewed-${tag}`,
};

const FIXTURES: Fixture[] = [
  // MUST be flagged: `src/touched.ts` is edited after this memory.
  { id: IDS.touched, anchors: [{ path: "src/touched.ts" }], timestamp: DATES.memories },
  // MUST be flagged: anchored at the PRE-rename path; the file is renamed and
  // then edited afterwards. This is the rename-following case.
  { id: IDS.renamed, anchors: [{ path: "src/old.ts" }], timestamp: DATES.memories },
  // MUST be flagged: file-level trigger reaches a symbol-qualified anchor.
  {
    id: IDS.symbolAnchored,
    anchors: [{ path: "src/touched.ts", symbol: "handler" }],
    timestamp: DATES.memories,
  },
  // MUST be flagged: a pre-M12 memory with paths only in `relatedNodes` still
  // gets checked, via the read-time fallback in graph-store's row mapper.
  //
  // The 32-hex entry alongside the path is a real spec.md §3.2 node id —
  // sha256("repo\0src/parse.ts#parseAnchor") truncated to 32 hex chars, as the
  // structural graph wrote them until M15. It is here because M15 removed the
  // graph but NOT this column, and the two failure modes it guards are
  // opposite: drop `related_nodes` from `listExperiencesByAnchorPaths`'s
  // predicate and this memory becomes invisible to the staleness pass
  // entirely; drop `isNodeId` from `anchorsFromRelatedNodes` and the node id
  // becomes an "anchor" naming a file that has never existed, which git can
  // never check. The whole pre-M12 corpus is shaped like this row.
  {
    id: IDS.legacyRelatedNodes,
    anchors: [],
    relatedNodes: ["src/touched.ts", "4f82b9813f16ef750be0145a4f2755d8"],
    timestamp: DATES.memories,
  },
  // MUST be flagged: the commit touching this path was AUTHORED after the
  // memory, even though it was COMMITTED long before. Author date is what
  // capture stamps on memories, so author date is what staleness compares.
  { id: IDS.skewed, anchors: [{ path: "src/skewed.ts" }], timestamp: DATES.memories },
  // MUST NOT be flagged: nothing touches this path after the initial commit.
  { id: IDS.untouched, anchors: [{ path: "src/untouched.ts" }], timestamp: DATES.memories },
  // MUST NOT be flagged: anchored to a changed path, but newer than every commit.
  {
    id: IDS.newerThanHistory,
    anchors: [{ path: "src/touched.ts" }],
    timestamp: AFTER_ALL_COMMITS,
  },
  // MUST NOT be flagged: no anchors at all, and must still not be dropped.
  { id: IDS.unanchored, anchors: [], timestamp: DATES.memories },
];

async function seed(): Promise<void> {
  for (const fixture of FIXTURES) {
    const experience: Experience = {
      id: fixture.id,
      task: `m12 fixture ${fixture.id}`,
      observation: `synthesized understanding for ${fixture.id}, recorded before the history moved on`,
      relatedNodes: fixture.relatedNodes ?? [],
      anchors: fixture.anchors,
      confidence: 0.6,
      timestamp: fixture.timestamp,
    };
    await recordExperience(experience);
  }
}

d("markSuspectFromHistory over a fixture repo (ROADMAP.md M12)", () => {
  beforeAll(async () => {
    await runMigrations();
    repo = await buildFixtureRepo([
      {
        message: "initial",
        date: DATES.init,
        write: [
          { path: "src/touched.ts", content: bulkyContent("touched") },
          { path: "src/untouched.ts", content: bulkyContent("untouched") },
          { path: "src/old.ts", content: bulkyContent("old") },
        ],
      },
      {
        message: "edit touched.ts",
        date: DATES.editTouched,
        write: [{ path: "src/touched.ts", content: bulkyContent("touched", 1) }],
      },
      {
        message: "rename old.ts -> new.ts",
        date: DATES.rename,
        rename: [{ from: "src/old.ts", to: "src/new.ts" }],
      },
      {
        message: "edit the renamed file",
        date: DATES.editRenamed,
        write: [{ path: "src/new.ts", content: bulkyContent("old", 1) }],
      },
      {
        // A rebased/cherry-picked/imported commit: authored AFTER the memory,
        // but committed BEFORE it. `git log --since` filters on the committer
        // date, so a date-windowed walk drops this commit while the author-date
        // comparison would have flagged it.
        message: "skewed: authored late, committed early",
        date: DATES.skewedAuthor,
        committerDate: DATES.skewedCommitter,
        write: [{ path: "src/skewed.ts", content: bulkyContent("skewed", 1) }],
      },
    ]);
    await seed();
  });

  afterAll(async () => {
    repo?.cleanup();
    await closePool();
  });

  it("flags exactly the memories the history overtook", async () => {
    const result = await markSuspectFromHistory({ repoDir: repo.dir });

    const marked = new Set(result.markedIds);
    // Every memory anchored to a path a later commit touched.
    expect(marked).toContain(IDS.touched);
    expect(marked).toContain(IDS.renamed);
    expect(marked).toContain(IDS.symbolAnchored);
    expect(marked).toContain(IDS.legacyRelatedNodes);
    expect(marked).toContain(IDS.skewed);
    // ...and nothing else from this fixture set.
    expect(marked).not.toContain(IDS.untouched);
    expect(marked).not.toContain(IDS.newerThanHistory);
    expect(marked).not.toContain(IDS.unanchored);
  });

  it("persists the flag and a reason naming the change", async () => {
    await markSuspectFromHistory({ repoDir: repo.dir });

    const touched = await getExperienceById(IDS.touched);
    expect(touched?.suspect).toBe(true);
    expect(touched?.suspectReason).toContain("src/touched.ts");

    const fresh = await getExperienceById(IDS.untouched);
    expect(fresh?.suspect).toBe(false);
    expect(fresh?.suspectReason).toBeUndefined();
  });

  it("attributes the rename itself, following the anchor to its new path", async () => {
    await markSuspectFromHistory({ repoDir: repo.dir });
    const renamed = await getExperienceById(IDS.renamed);
    expect(renamed?.suspect).toBe(true);
    // Newest matching change wins the headline: the edit to the new path.
    expect(renamed?.suspectReason).toContain("src/new.ts");
  });

  it("is idempotent — re-running over unchanged history changes nothing", async () => {
    const first = await markSuspectFromHistory({ repoDir: repo.dir });
    const second = await markSuspectFromHistory({ repoDir: repo.dir });
    expect(second.marked).toBe(first.marked);
    expect([...second.markedIds].sort()).toEqual([...first.markedIds].sort());
  });

  it("never drops a flagged memory — it stays retrievable, tagged", async () => {
    await markSuspectFromHistory({ repoDir: repo.dir });
    const stillThere = await getExperienceById(IDS.touched);
    expect(stillThere).toBeDefined();
    expect(stillThere?.observation).toContain("synthesized understanding");
  });

  it("finds candidates by anchor path, including symbol-qualified anchors", async () => {
    const hits = await listExperiencesByAnchorPaths(["src/touched.ts"]);
    const ids = hits.map((h) => h.id);
    // jsonb containment matches `{path}` against `{path, symbol}` too — the
    // reason migration 0006 stores anchors as objects in one array.
    expect(ids).toContain(IDS.touched);
    expect(ids).toContain(IDS.symbolAnchored);
    expect(ids).not.toContain(IDS.untouched);
  });

  it("stores anchors as typed objects and round-trips them", async () => {
    const symbolAnchored = await getExperienceById(IDS.symbolAnchored);
    expect(symbolAnchored?.anchors).toEqual([{ path: "src/touched.ts", symbol: "handler" }]);
  });

  it("derives anchors from relatedNodes for a memory written before migration 0006, dropping a legacy structural node id", async () => {
    const legacy = await getExperienceById(IDS.legacyRelatedNodes);
    // The path becomes an anchor; the node id does not — a node id names a
    // symbol, so there is nothing for git to check it against, and since M15
    // nothing can dereference it either (spec.md §24.7).
    expect(legacy?.anchors).toEqual([{ path: "src/touched.ts" }]);
    // ...and the stored column is untouched: M15 preserves history rather than
    // rewriting it tidy.
    expect(legacy?.relatedNodes).toEqual([
      "src/touched.ts",
      "4f82b9813f16ef750be0145a4f2755d8",
    ]);
  });

  it("finds a pre-M12 memory by anchor path through the relatedNodes leg (M15 kept that column for exactly this)", async () => {
    // `listExperiencesByAnchorPaths` matches `anchors` OR `related_nodes`.
    // This memory has an EMPTY `anchors` array, so only the second leg can
    // reach it — which is why migration 0008 retires the `nodes`/`edges`
    // tables but not `experiences.related_nodes` or its GIN index.
    const hits = await listExperiencesByAnchorPaths(["src/touched.ts"]);
    expect(hits.map((h) => h.id)).toContain(IDS.legacyRelatedNodes);
  });

  it("a verification survives the read-time recompute — the repair is not undone by the next read (M13)", async () => {
    // The failure this pins: `clearExperienceSuspect` alone clears the
    // PERSISTED verdict, but §24.2.3's verdict is also recomputed from git on
    // every read, and the commit that raised it is still newer than the
    // memory's write instant. Without `verified_at`, read-repair's "I checked;
    // it is accurate" outcome would be reverted by the very next query.
    await markSuspectFromHistory({ repoDir: repo.dir });
    const before = await getExperienceById(IDS.touched);
    expect(before?.suspect).toBe(true);
    expect((await flagPossiblyStale([before as Experience], { repoDir: repo.dir }))[0]?.possiblyStale).toBe(
      true
    );

    // Verified now — after every commit in the fixture.
    await markExperienceVerified(IDS.touched, AFTER_ALL_COMMITS);
    const verified = await getExperienceById(IDS.touched);
    expect(verified?.suspect).toBe(false);
    expect(
      (await flagPossiblyStale([verified as Experience], { repoDir: repo.dir }))[0]?.possiblyStale
    ).toBe(false);

    // ...and a re-run of the sync pass does not re-flag it either.
    await markSuspectFromHistory({ repoDir: repo.dir });
    expect((await getExperienceById(IDS.touched))?.suspect).toBe(false);

    // Verifying is not suppressing: a memory verified BEFORE the fixture's
    // commits is still flagged by them.
    await markExperienceVerified(IDS.touched, "2026-01-20T00:00:00Z");
    const staleAgain = await getExperienceById(IDS.touched);
    expect(
      (await flagPossiblyStale([staleAgain as Experience], { repoDir: repo.dir }))[0]?.possiblyStale
    ).toBe(true);

    // Restore, so test order cannot affect the other cases.
    await clearVerification(IDS.touched);
    await markSuspectFromHistory({ repoDir: repo.dir });
  });

  it("clearExperienceSuspect undoes the flag (the hook M13 read-repair needs)", async () => {
    await markSuspectFromHistory({ repoDir: repo.dir });
    expect((await getExperienceById(IDS.touched))?.suspect).toBe(true);

    await clearExperienceSuspect(IDS.touched);
    expect((await getExperienceById(IDS.touched))?.suspect).toBe(false);
    expect((await getExperienceById(IDS.touched))?.suspectReason).toBeUndefined();

    // Restore, so test order cannot affect the other cases.
    await markSuspectFromHistory({ repoDir: repo.dir });
  });

  it("read-time flagging agrees with the persisted sync-time verdict", async () => {
    await markSuspectFromHistory({ repoDir: repo.dir });
    const stored = await Promise.all(
      [IDS.touched, IDS.renamed, IDS.untouched, IDS.newerThanHistory].map((id) =>
        getExperienceById(id)
      )
    );
    const experiences = stored.filter((e): e is Experience => e !== undefined);
    const verdicts = await flagPossiblyStale(experiences, { repoDir: repo.dir });

    // The two paths into §24.2.3 must not disagree: one persists the verdict at
    // sync time, the other recomputes it at read time from the same history.
    for (const verdict of verdicts) {
      expect(verdict.possiblyStale).toBe(verdict.experience.suspect === true);
    }
  });

  it("flags a commit authored after the memory but committed before it (author/committer skew)", async () => {
    // Regression guard for a real bug this milestone had: deriving the git walk's
    // `--since` from the batch's oldest memory looks like a free optimization,
    // but `--since` filters on the COMMITTER date while the staleness comparison
    // uses the AUTHOR date (`%aI`, which is what capture stamps on a memory).
    // A rebased commit like this one was silently dropped by that window and
    // never flagged. The walk is bounded by commit count instead.
    await markSuspectFromHistory({ repoDir: repo.dir });
    const skewed = await getExperienceById(IDS.skewed);
    expect(skewed?.suspect).toBe(true);
    expect(skewed?.suspectReason).toContain("src/skewed.ts");

    // And the read path agrees, with no `since` passed.
    const unbounded = await flagPossiblyStale(
      [{ ...skewed!, suspect: false, suspectReason: undefined }],
      { repoDir: repo.dir }
    );
    expect(unbounded[0]?.possiblyStale).toBe(true);

    // And a `since` bound no longer changes the answer, which is the actual
    // fix. `since` is applied in memory on the AUTHOR date, so it uses the same
    // clock as the comparison. Handing it to `git log --since` instead — the
    // "obvious optimization" — filtered this commit out on its 2025 COMMITTER
    // date and returned the opposite verdict for the same memory in the same
    // repo. Asserted here so that regression cannot come back quietly.
    const dateWindowed = await flagPossiblyStale(
      [{ ...skewed!, suspect: false, suspectReason: undefined }],
      { repoDir: repo.dir, since: DATES.memories }
    );
    expect(dateWindowed[0]?.possiblyStale).toBe(true);

    // The bound still bounds: a floor above the commit's author date drops it.
    const tooLate = await flagPossiblyStale(
      [{ ...skewed!, suspect: false, suspectReason: undefined }],
      { repoDir: repo.dir, since: AFTER_ALL_COMMITS }
    );
    expect(tooLate[0]?.possiblyStale).toBe(false);
  });

  it("a window that starts after the rename cannot follow it — documented, not silent", async () => {
    // `changedPathUniverse`'s caveat, enforced: with an author-date floor past
    // the rename commit, `src/old.ts` never appears in the change set, so the
    // memory anchored there is not even a candidate. This is why the sync pass
    // applies no date bound by default.
    await clearExperienceSuspect(IDS.renamed);
    const result = await markSuspectFromHistory({
      repoDir: repo.dir,
      since: DATES.editRenamed,
    });
    expect(result.markedIds).not.toContain(IDS.renamed);

    // Restore the full-history verdict.
    await markSuspectFromHistory({ repoDir: repo.dir });
    expect((await getExperienceById(IDS.renamed))?.suspect).toBe(true);
  });
});
