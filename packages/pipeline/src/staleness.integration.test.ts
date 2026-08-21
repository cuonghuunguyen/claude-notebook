/**
 * The read-time half of spec.md §24.2.3, end to end: a task string in, an
 * `AgentContext` out with the memory the history has overtaken tagged
 * `possibly-stale — verify before trusting`.
 *
 * This is the milestone's headline behaviour and the only test that covers the
 * whole path at once — real Postgres, real git, real `runPipeline`. The unit
 * suites cover the matching rules; this one covers the wiring between them,
 * which is where a milestone like this actually breaks.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POSSIBLY_STALE_FLAG } from "@cognitive-memory/core";
import { renderContext } from "@cognitive-memory/context";
import { recordExperience } from "@cognitive-memory/episodic";
import { closePool, runMigrations } from "@cognitive-memory/graph-store";
import { createFakeEmbedder } from "@cognitive-memory/core";
import { bulkyContent, buildFixtureRepo, type FixtureRepo } from "@cognitive-memory/staleness/fixtureRepo";
import { runPipeline } from "./pipeline.js";

const hasDb = Boolean(process.env["DATABASE_URL"]);
const d = hasDb ? describe : describe.skip;

const DATES = {
  init: "2026-01-01T00:00:00Z",
  memories: "2026-01-15T00:00:00Z",
  edit: "2026-02-01T00:00:00Z",
};

/** Unique per run so parallel workers and re-runs never collide in the shared corpus. */
const tag = randomUUID().slice(0, 8);
const TOPIC = `zorblax${tag}`;

let repo: FixtureRepo;

function pipelineOptions(extra: Record<string, unknown> = {}) {
  return {
    embedder: createFakeEmbedder(),
    ...extra,
  };
}

d("runPipeline read-time staleness (spec.md §24.2.3)", () => {
  beforeAll(async () => {
    await runMigrations();
    repo = await buildFixtureRepo([
      {
        message: "initial",
        date: DATES.init,
        write: [
          { path: "src/stale-target.ts", content: bulkyContent("target") },
          { path: "src/quiet.ts", content: bulkyContent("quiet") },
        ],
      },
      {
        message: "edit stale-target.ts",
        date: DATES.edit,
        write: [{ path: "src/stale-target.ts", content: bulkyContent("target", 1) }],
      },
    ]);

    // Two memories, identical except for which file they are anchored to. Both
    // are older than the edit; only one is anchored to the file it touched, so
    // any difference in their verdicts is caused by the anchor and nothing else.
    await recordExperience({
      id: `pipe-stale-${tag}`,
      task: `why ${TOPIC} retries twice`,
      observation: `${TOPIC} retries twice because the first attempt warms the connection pool`,
      lessons: [`${TOPIC} retries twice on purpose.`],
      relatedNodes: [],
      anchors: [{ path: "src/stale-target.ts" }],
      confidence: 0.7,
      timestamp: DATES.memories,
    });
    await recordExperience({
      id: `pipe-fresh-${tag}`,
      task: `why ${TOPIC} logs at debug level`,
      observation: `${TOPIC} logs at debug level because the audit sink samples aggressively`,
      lessons: [`${TOPIC} logging is deliberately quiet.`],
      relatedNodes: [],
      anchors: [{ path: "src/quiet.ts" }],
      confidence: 0.7,
      timestamp: DATES.memories,
    });
  });

  afterAll(async () => {
    repo?.cleanup();
    await closePool();
  });

  it("tags the memory whose anchored file was touched, and only that one", async () => {
    const { context, staleness } = await runPipeline(
      `why does ${TOPIC} behave this way`,
      pipelineOptions({ stalenessRepoDir: repo.dir })
    );

    const byId = new Map(context.experiences.map((e) => [e.experienceId, e]));
    expect(byId.get(`pipe-stale-${tag}`)?.staleness).toBe(POSSIBLY_STALE_FLAG);
    expect(byId.get(`pipe-fresh-${tag}`)?.staleness).toBeUndefined();

    const verdicts = new Map(staleness.map((v) => [v.experience.id, v]));
    expect(verdicts.get(`pipe-stale-${tag}`)?.possiblyStale).toBe(true);
    expect(verdicts.get(`pipe-stale-${tag}`)?.reason).toContain("src/stale-target.ts");
    expect(verdicts.get(`pipe-fresh-${tag}`)?.possiblyStale).toBe(false);
  });

  it("still returns the stale memory's content — flagged, not withheld", async () => {
    const { context } = await runPipeline(
      `why does ${TOPIC} behave this way`,
      pipelineOptions({ stalenessRepoDir: repo.dir })
    );
    const stale = context.experiences.find((e) => e.experienceId === `pipe-stale-${tag}`);
    expect(stale?.lessons).toEqual([`${TOPIC} retries twice on purpose.`]);
  });

  it("the rendered context an agent reads carries the warning", async () => {
    const { context } = await runPipeline(
      `why does ${TOPIC} behave this way`,
      pipelineOptions({ stalenessRepoDir: repo.dir })
    );
    const rendered = renderContext(context);
    expect(rendered).toContain(POSSIBLY_STALE_FLAG);
    expect(rendered).toContain(`${TOPIC} retries twice on purpose.`);
  });

  it("without stalenessRepoDir it does no git work and tags nothing", async () => {
    // The pipeline must stay usable against a database with no checkout in
    // reach — an eval harness, a hosted retrieval service.
    const { context, staleness } = await runPipeline(
      `why does ${TOPIC} behave this way`,
      pipelineOptions()
    );
    expect(staleness).toEqual([]);
    expect(context.experiences.every((e) => e.staleness === undefined)).toBe(true);
  });

  it("degrades instead of failing when stalenessRepoDir is not a git repo", async () => {
    // An advisory annotation must not be able to break the thing it annotates:
    // losing the memory entirely is the more expensive error (§24.2.3).
    const { context, staleness } = await runPipeline(
      `why does ${TOPIC} behave this way`,
      pipelineOptions({ stalenessRepoDir: "/nonexistent-path-for-m12-test" })
    );
    expect(staleness).toEqual([]);
    expect(context.experiences.length).toBeGreaterThan(0);
    expect(context.experiences.every((e) => e.staleness === undefined)).toBe(true);
  });

  it("returns a verdict for every experience it put in the context", async () => {
    const { context, staleness } = await runPipeline(
      `why does ${TOPIC} behave this way`,
      pipelineOptions({ stalenessRepoDir: repo.dir })
    );
    // buildContext may truncate, so verdicts are a superset of context entries —
    // but every context entry must have one, or the flag silently goes missing.
    // Keyed by id, NOT by position: buildContext re-sorts by recency while
    // verdicts stay in pipeline (relevance) order, so index i of one is
    // routinely a different memory than index i of the other.
    const verdictIds = new Set(staleness.map((v) => v.experience.id));
    for (const experience of context.experiences) {
      expect(verdictIds).toContain(experience.experienceId);
    }
  });

  it("verdicts must be keyed by id — position does not line up with the context", async () => {
    const { context, staleness } = await runPipeline(
      `why does ${TOPIC} behave this way`,
      pipelineOptions({ stalenessRepoDir: repo.dir })
    );
    // Pin the documented contract: matching by id gives the right verdict for
    // the flagged memory, whatever the two orderings happen to be.
    const byId = new Map(staleness.map((v) => [v.experience.id, v]));
    const staleEntry = context.experiences.find(
      (e) => e.experienceId === `pipe-stale-${tag}`
    );
    expect(staleEntry?.staleness).toBe(POSSIBLY_STALE_FLAG);
    expect(byId.get(`pipe-stale-${tag}`)?.possiblyStale).toBe(true);
  });
});
