import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { queryByMeaning } from "@cognitive-memory/episodic";
import { closePool, getPool, runMigrations } from "@cognitive-memory/graph-store";
import { createFakeEmbedder } from "@cognitive-memory/retrieval";
import { captureGitHistory, commitAction } from "./git.js";
import { recordScoutReport } from "./scout.js";
import { buildFixtureRepo, type FixtureCommit, type FixtureRepo } from "./testing.js";

// Same DATABASE_URL-gating convention as every other integration suite in
// this repo — skipped, not failed, without a real Postgres.
const hasDb = Boolean(process.env["DATABASE_URL"]);
const d = hasDb ? describe : describe.skip;

/** A unique token in every body, so a run never reads another run's rows. */
const MARKER = `cap${randomUUID().replace(/-/g, "")}`;

const FIXTURE_COMMITS: FixtureCommit[] = [
  {
    subject: `fix(${MARKER}): keep the object fastpass result instead of returning early`,
    body:
      `The optional-key branch in the ${MARKER} fastpass returned before running the ` +
      `assignment, so a successfully parsed value was discarded and the caller saw ` +
      `undefined. It looked like a JIT problem but the leak was ours: the branch has to ` +
      `assign before it returns, because the fastpass has nowhere else to keep the value ` +
      `and re-walking the shape on every optional key was measurably slower.`,
    files: ["src/parse.ts"],
    date: "2024-02-03T10:00:00Z",
  },
  {
    subject: `fix(${MARKER}): skip __proto__ in the closed-key pass-through`,
    body:
      `Record parsing copied every own key through, which meant a payload with a ` +
      `${MARKER} __proto__ key from JSON.parse could reach the prototype chain. We skip ` +
      `that one key explicitly instead of switching to a for-in walk, because for-in ` +
      `would also pull inherited keys and that breaks the closed-key contract.`,
    files: ["src/record.ts"],
    date: "2024-05-06T10:00:00Z",
  },
  {
    subject: `revert(${MARKER}): stop rejecting whitespace in base64`,
    body:
      `This reverts the ${MARKER} whitespace rejection. It was never meant to land on ` +
      `main — it was pushed directly instead of through its pull request branch, so it ` +
      `bypassed review entirely. Reverting because the behaviour change is breaking, ` +
      `not because the idea is wrong.`,
    files: ["src/base64.ts"],
    date: "2024-08-09T10:00:00Z",
  },
  {
    // Deliberately unexplanatory: no body worth remembering.
    subject: `chore(${MARKER}): bump version`,
    body: "",
    files: ["src/version.ts"],
    date: "2024-09-09T10:00:00Z",
  },
  {
    // Deliberately out of the mined path scope.
    subject: `fix(${MARKER}): docs only, out of scope`,
    body:
      `A long explanatory body that would pass the selection rule, but every file it ` +
      `touches is outside the mined path scope, so it must not be recorded because the ` +
      `capture run was never asked about that part of the tree at all.`,
    files: ["docs/readme.md"],
    date: "2024-10-10T10:00:00Z",
  },
];

d("git-history capture (spec.md §24.2.1 / ROADMAP.md M11)", () => {
  let repo: FixtureRepo;

  beforeAll(async () => {
    await runMigrations();
    repo = await buildFixtureRepo(FIXTURE_COMMITS);
  });

  afterAll(async () => {
    // Guarded: if beforeAll threw before assigning `repo`, an unguarded
    // `repo.dir` here raises a TypeError that masks the real failure.
    if (repo) rmSync(repo.dir, { recursive: true, force: true });
    await closePool();
  });

  it("records only the self-explaining commits inside the path scope, dated by the history", async () => {
    const result = await captureGitHistory({ repoDir: repo.dir, pathScope: "src" });

    expect(result.recorded).toBe(3);
    expect(result.mined).toBe(3); // the chore and the out-of-scope commit never even mine
    expect(result.alreadyRecorded).toBe(0);

    const actions = result.experiences.map((e) => e.action);
    expect(actions).toContain(commitAction(repo.shortShas[0]!));
    expect(actions).toContain(commitAction(repo.shortShas[1]!));
    expect(actions).toContain(commitAction(repo.shortShas[2]!));
    expect(actions).not.toContain(commitAction(repo.shortShas[3]!));
    expect(actions).not.toContain(commitAction(repo.shortShas[4]!));

    // Anchors are the commit's own repo-relative paths, as plain text — no
    // structural node for any of them exists in this database.
    const anchors = result.experiences.flatMap((e) => e.relatedNodes);
    expect(anchors.sort()).toEqual(["src/base64.ts", "src/parse.ts", "src/record.ts"]);
    const { rows } = await getPool().query<{ count: string }>(
      "SELECT count(*) FROM nodes WHERE path = ANY($1::text[])",
      [anchors]
    );
    expect(Number(rows[0]?.count)).toBe(0);

    // spec.md §24.2.3 needs the memory dated by the commit, not by the sync.
    const parse = result.experiences.find((e) => e.relatedNodes.includes("src/parse.ts"));
    expect(parse?.timestamp.slice(0, 10)).toBe("2024-02-03");

    // M12: the same paths also land in the typed `anchors` column, so the
    // staleness pass can find this memory by anchor rather than by guessing
    // which `relatedNodes` entries happen to be paths.
    expect(parse?.anchors).toEqual([{ path: "src/parse.ts" }]);
    // Path-only, deliberately: `git log --name-status` names files, not
    // symbols, and inferring one would need the parser spec.md §24.2 point 7
    // keeps off this path.
    expect(result.experiences.every((e) => e.anchors?.every((a) => a.symbol === undefined))).toBe(
      true
    );
  });

  it("re-running over the same history writes nothing new", async () => {
    const before = await countMarkedExperiences();

    const rerun = await captureGitHistory({ repoDir: repo.dir, pathScope: "src" });

    expect(rerun.recorded).toBe(0);
    expect(rerun.experiences).toEqual([]);
    expect(rerun.alreadyRecorded).toBe(3);
    expect(await countMarkedExperiences()).toBe(before);
  });

  it("records a newly appended commit on a re-run without touching the ones already stored", async () => {
    const grown = await buildFixtureRepo([
      ...FIXTURE_COMMITS,
      {
        subject: `fix(${MARKER}): anchor the iso regex through a helper`,
        body:
          `esbuild will not treat an interpolated ${MARKER} regex literal as pure, so the ` +
          `dead-code pass kept the whole module in every bundle. Building it through an ` +
          `anchor() helper keeps the interpolation out of the literal, which is why the ` +
          `helper exists at all rather than for readability.`,
        files: ["src/iso.ts"],
        date: "2024-11-11T10:00:00Z",
      },
    ]);
    try {
      // A fresh clone re-derives the same shas for the same content and dates,
      // so the first five are already recorded and only the sixth is new.
      const result = await captureGitHistory({ repoDir: grown.dir, pathScope: "src" });
      expect(result.recorded).toBe(1);
      expect(result.alreadyRecorded).toBe(3);
      expect(result.experiences[0]?.relatedNodes).toEqual(["src/iso.ts"]);
    } finally {
      rmSync(grown.dir, { recursive: true, force: true });
    }
  });

  it("mined knowledge is retrievable by meaning from a paraphrase, with no structural node in existence", async () => {
    const hits = await queryByMeaning(
      `${MARKER} what could a payload with a __proto__ key reach in record parsing`,
      { limit: 5 }
    );
    const top = hits[0];
    expect(top, `no by-meaning hits for the ${MARKER} corpus`).toBeDefined();
    expect(top?.experience.observation).toContain("__proto__");
    expect(top?.experience.relatedNodes).toEqual(["src/record.ts"]);
    // Anchored to a path, and NOT to any node — see the zero-node assertion
    // above. `anchored` says an anchor exists, not that the graph knows it.
    expect(top?.anchored).toBe(true);
  });

  it("also binds structural node ids when a resolver is injected, without dropping the text anchors", async () => {
    const solo = await buildFixtureRepo([
      {
        subject: `fix(${MARKER}-resolver): the domain regex needs a leading lookahead`,
        body:
          `A ${MARKER}-resolver domain is limited to 253 characters in total by RFC 1035, ` +
          `and per-label quantifiers cannot express a limit on the whole string, so the ` +
          `pattern opens with a lookahead asserting the total length before matching any ` +
          `label at all.`,
        files: ["src/regexes.ts"],
        date: "2024-12-12T10:00:00Z",
      },
    ]);
    try {
      const result = await captureGitHistory({
        repoDir: solo.dir,
        pathScope: "src",
        resolveNodeIds: (paths) => paths.map((p) => `fake-node-id:${p}`),
      });
      expect(result.recorded).toBe(1);
      expect(result.experiences[0]?.relatedNodes.sort()).toEqual([
        "fake-node-id:src/regexes.ts",
        "src/regexes.ts",
      ]);
    } finally {
      rmSync(solo.dir, { recursive: true, force: true });
    }
  });

  it("writes an embedding for the vector leg when an embedder is injected", async () => {
    const solo = await buildFixtureRepo([
      {
        subject: `fix(${MARKER}-embed): move the iso classes out of iso.ts`,
        body:
          `The ${MARKER}-embed ZodISODate classes were defined in iso.ts, which the ` +
          `classic facade re-exports, producing a circular import that rollup resolved ` +
          `to undefined at module init. Defining them in schemas.ts and re-exporting ` +
          `breaks the cycle without changing the public surface.`,
        files: ["src/schemas.ts"],
        date: "2025-01-01T10:00:00Z",
      },
    ]);
    try {
      const result = await captureGitHistory({
        repoDir: solo.dir,
        pathScope: "src",
        embedder: createFakeEmbedder(),
      });
      const id = result.experiences[0]?.id;
      const { rows } = await getPool().query<{ has: boolean }>(
        "SELECT embedding IS NOT NULL AS has FROM experiences WHERE id = $1",
        [id]
      );
      expect(rows[0]?.has).toBe(true);
    } finally {
      rmSync(solo.dir, { recursive: true, force: true });
    }
  });

  async function countMarkedExperiences(): Promise<number> {
    const { rows } = await getPool().query<{ count: string }>(
      "SELECT count(*) FROM experiences WHERE observation LIKE $1 OR task LIKE $1",
      [`%${MARKER}%`]
    );
    return Number(rows[0]?.count);
  }
});

d("scout-report capture (spec.md §24.2.1 second source class)", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await closePool();
  });

  it("a distilled scout report is retrievable by a paraphrased how-does-X-work question, anchored to plain text paths", async () => {
    const marker = `scout${randomUUID().replace(/-/g, "")}`;
    const recorded = await recordScoutReport({
      task: `how the ${marker} traversal budget stops a walk`,
      understanding:
        `The ${marker} walk is bounded by four independent counters, not one: depth, ` +
        `node count, edge count and reasoning calls. Whichever trips first ends the ` +
        `walk, and the stop reason names it, so a walk that ends at depth two has not ` +
        `necessarily run out of depth. The counter that trips in practice is almost ` +
        `always the reasoning-call one, because each expansion round costs one call ` +
        `regardless of how many candidate edges that round considered. The consequence ` +
        `worth knowing is that widening the frontier is nearly free while deepening it ` +
        `is not, which is the opposite of what the budget names suggest.`,
      anchors: ["packages/traversal/src/traverse.ts", "packages/core/src/types.ts"],
      source: "integration-test",
    });

    expect(recorded.action).toBe("scout-report integration-test");
    expect(recorded.relatedNodes).toEqual([
      "packages/traversal/src/traverse.ts",
      "packages/core/src/types.ts",
    ]);
    // M12: typed anchors alongside the text mirror.
    expect(recorded.anchors).toEqual([
      { path: "packages/traversal/src/traverse.ts" },
      { path: "packages/core/src/types.ts" },
    ]);

    // No structural node exists for either anchor.
    const { rows } = await getPool().query<{ count: string }>(
      "SELECT count(*) FROM nodes WHERE id = ANY($1::text[])",
      [recorded.relatedNodes]
    );
    expect(Number(rows[0]?.count)).toBe(0);

    // Paraphrase, not the recorded wording.
    const hits = await queryByMeaning(
      `${marker} which limit actually ends a traversal in practice`,
      { limit: 5 }
    );
    expect(hits.map((h) => h.experience.id)).toContain(recorded.id);
  });

  it("accepts path#symbol anchors — a scout report is the one source that knows a symbol", async () => {
    // Unlike the git miner (which sees only name-status), the agent writing a
    // scout report actually read the code, so spec.md §24.2.2's optional
    // `symbol` half is reachable here. The string form is what
    // `.claude/scout-report.json` writes by hand.
    const recorded = await recordScoutReport({
      task: `how ${randomUUID().slice(0, 8)} confidence promotion is computed`,
      understanding:
        "Confidence is recomputed from provenance on every read rather than stored, so " +
        "an edge's stage is a derivation and never a column that can drift out of date. " +
        "The consequence worth knowing is that adding a provenance entry retroactively " +
        "changes the stage of every edge that shares it, which is intended: the evidence " +
        "hierarchy is the single source of truth and the stage is only ever a view of it.",
      anchors: [
        "packages/semantic/src/confidence.ts#computeConfidence",
        { path: "packages/semantic/src/edge.ts", symbol: "stageFor" },
      ],
      source: "integration-test-symbols",
    });

    expect(recorded.anchors).toEqual([
      { path: "packages/semantic/src/confidence.ts", symbol: "computeConfidence" },
      { path: "packages/semantic/src/edge.ts", symbol: "stageFor" },
    ]);
    // Mirrored back into `relatedNodes` in text form, so the column keeps one
    // consistent representation.
    expect(recorded.relatedNodes).toEqual([
      "packages/semantic/src/confidence.ts#computeConfidence",
      "packages/semantic/src/edge.ts#stageFor",
    ]);
  });

  it("refuses a report whose anchors are all blank — an anchor that matches no file is not an anchor", async () => {
    await expect(
      recordScoutReport({
        task: "how something works",
        understanding:
          "The promotion pipeline treats every observation as evidence rather than as a " +
          "fact, so two independent source types are what move an edge from observation " +
          "to candidate, and a single high-confidence source never can on its own. That " +
          "is why a structural extraction pass alone leaves everything at observation " +
          "stage no matter how many files it reads, which surprises people.",
        anchors: ["", "   "],
      })
    ).rejects.toThrow(/anchor/i);
  });

  it("refuses a report that is only file locations, before it can pollute retrieval", async () => {
    await expect(
      recordScoutReport({
        task: "where things live",
        understanding:
          "- packages/retrieval/src/retrieve.ts\n- packages/retrieval/src/merge.ts\n" +
          "- packages/retrieval/src/expand.ts\n- packages/graph-store/src/nodes.ts\n" +
          "- packages/graph-store/src/edges.ts\n- packages/traversal/src/traverse.ts\n",
        anchors: ["packages/retrieval/src/retrieve.ts"],
      })
    ).rejects.toThrow(/§24.2.1/);
  });

  it("refuses an unanchored report — a memory nothing can be checked against", async () => {
    await expect(
      recordScoutReport({
        task: "how something works",
        understanding:
          "The promotion pipeline treats every observation as evidence rather than as a " +
          "fact, so two independent source types are what move an edge from observation " +
          "to candidate, and a single high-confidence source never can on its own. That " +
          "is why a structural extraction pass alone leaves everything at observation " +
          "stage, which reads like a bug until you know the rule.",
        anchors: [],
      })
    ).rejects.toThrow(/anchor path/);
  });
});
