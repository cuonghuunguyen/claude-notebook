/**
 * The why-spike retrieval measurement, re-run through the shipped package path
 * and small enough to run in CI (ROADMAP.md M11's last acceptance bullet).
 *
 * `WHY_MEMORY_SPIKE.md` measured two ways of reaching recorded reasoning over
 * zod's real history: matching the question against the experience text scored
 * MRR 0.75, while the shipped node-gated path scored 0.13. Those numbers came
 * from code that lived in this eval package. M11 moved the winning path into
 * `packages/capture` + `packages/episodic`, so this suite re-measures it
 * through the product — over a self-contained fixture history, because a full
 * zod clone is not available in CI. `results/probe.json` (see README.md) is the
 * run against the real repository.
 *
 * The comparison arm is deliberately *generous* to the design by-meaning
 * replaced: instead of making it earn its seeds through retrieval and
 * traversal, it is handed the correct anchor for free and asked for the
 * memories bound to it, newest first — the best case anchor gating could ever
 * have. It still loses, because what it orders by is recency, and the memory
 * that answers a "why" question is usually not the newest one on the file.
 *
 * Since M15 that arm reaches the memories through their *text* anchor
 * (`listExperiencesByAnchorPaths`) rather than through a structural node id.
 * That is not a weakening of the baseline — it is the same "everything bound to
 * this file, newest first" window, with the node hop that M15's gate measured
 * at 0.00 MRR taken out of the middle of it.
 */
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureGitHistory } from "@cognitive-memory/capture";
import { buildFixtureRepo, type FixtureRepo } from "@cognitive-memory/capture/testing";
import { queryByMeaning } from "@cognitive-memory/episodic";
import { closePool, listExperiencesByAnchorPaths, runMigrations } from "@cognitive-memory/graph-store";
import {
  DISTRACTORS_PER_ANCHOR,
  KNOWLEDGE_EVAL_COMMITS,
  KNOWLEDGE_EVAL_QUESTIONS,
} from "./knowledgeCases.js";

// Same DATABASE_URL-gating convention as every other integration/eval suite
// in this repo — skipped, not failed, without a real Postgres.
const hasDb = Boolean(process.env["DATABASE_URL"]);
const d = hasDb ? describe : describe.skip;

/** The node-gated MRR `WHY_MEMORY_SPIKE.md` measured, for reference. */
const ANCHOR_RECENCY_BASELINE_MRR = 0.13;
/** The by-meaning MRR it measured. "In the neighborhood" is read as within 0.15. */
const BY_MEANING_REFERENCE_MRR = 0.75;

const reciprocalRank = (rank: number): number => (rank >= 0 ? 1 / (rank + 1) : 0);
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * A per-run token stamped into every fixture commit subject and every question.
 *
 * It does two things at once. It makes each run's commit shas unique, so the
 * capture layer's own idempotency (a re-run writes nothing) does not leave the
 * second execution of this suite with an empty corpus. And it scopes retrieval
 * to this run's corpus on a database that other suites — and previous runs —
 * have also written to, without making the ranking any easier: the token is in
 * every one of this run's memories equally, so which one comes back first is
 * still decided entirely by the rest of the question.
 */
const RUN = `k${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const stamp = (subject: string): string => `${RUN}: ${subject}`;

const COMMITS = KNOWLEDGE_EVAL_COMMITS.map((c) => ({ ...c, subject: stamp(c.subject) }));
const QUESTIONS = KNOWLEDGE_EVAL_QUESTIONS.map((q) => ({
  ...q,
  question: `${RUN} ${q.question}`,
  answerSubject: stamp(q.answerSubject),
}));

d("knowledge retrieval eval (spec.md §24.2.1 / ROADMAP.md M11)", () => {
  let repo: FixtureRepo;
  /** question id -> the experience id that actually answers it. */
  const answerByQuestion = new Map<string, string>();
  const byMeaningRanks: number[] = [];
  const anchorRecencyRanks: number[] = [];

  beforeAll(async () => {
    await runMigrations();
    repo = await buildFixtureRepo(COMMITS);

    // Capture through the shipped package, exactly as a real sync would. Every
    // commit in the corpus is explanatory (the newer ones deliberately so), so
    // all of them land — including the distractors sharing each anchor.
    const captured = await captureGitHistory({ repoDir: repo.dir, pathScope: "src" });
    expect(captured.recorded).toBe(COMMITS.length);

    for (const question of QUESTIONS) {
      // The answering memory is identified by the commit subject it was mined
      // from, not by its anchor — the distractors share the anchor on purpose.
      const answer = captured.experiences.find((e) => e.task === question.answerSubject);
      expect(answer, `no captured memory for "${question.answerSubject}"`).toBeDefined();
      answerByQuestion.set(question.id, answer!.id);

      // Sanity: the anchor really is shared, so the node-gated arm below has to
      // choose rather than being right by having only one candidate — and the
      // number of competitors differs per question, so its score cannot be a
      // constant of the fixture.
      const sharing = captured.experiences.filter((e) => e.relatedNodes.includes(question.anchor));
      expect(sharing.length).toBe((DISTRACTORS_PER_ANCHOR[question.anchor] ?? 0) + 1);
    }

    for (const question of QUESTIONS) {
      const answerId = answerByQuestion.get(question.id)!;

      const byMeaning = await queryByMeaning(question.question, { limit: 10 });
      byMeaningRanks.push(byMeaning.findIndex((h) => h.experience.id === answerId));

      // The generous anchor-recency arm: the correct anchor handed over for
      // free, scoped to this run's corpus so a previous run's rows on the same
      // paths cannot flatter or penalise it. All it has left to do is order the
      // memories on that one file — and what it orders by is recency.
      const anchorRecency = (await listExperiencesByAnchorPaths([question.anchor])).filter((e) =>
        e.task.startsWith(`${RUN}:`)
      );
      expect(anchorRecency.length).toBeGreaterThan(1);
      anchorRecencyRanks.push(anchorRecency.findIndex((e) => e.id === answerId));
    }
  }, 60_000);

  afterAll(async () => {
    // Guarded: if beforeAll threw before assigning `repo`, an unguarded
    // `repo.dir` here raises a TypeError that masks the real failure.
    if (repo) rmSync(repo.dir, { recursive: true, force: true });
    await closePool();
  });

  it.each(QUESTIONS)("[by-meaning] $id", ({ id }) => {
    const index = QUESTIONS.findIndex((q) => q.id === id);
    expect(
      byMeaningRanks[index],
      `"${QUESTIONS[index]!.question}" did not retrieve its answer at all`
    ).toBeGreaterThanOrEqual(0);
  });

  it("by-meaning MRR lands in the neighborhood of the spike's 0.75 and decisively above the anchor-recency window", () => {
    const byMeaningMrr = mean(byMeaningRanks.map(reciprocalRank));
    const anchorRecencyMrr = mean(anchorRecencyRanks.map(reciprocalRank));

    // Printed, not just asserted: the number is the deliverable here, and a
    // human reading CI output should be able to see it without a debugger.
    console.log(
      JSON.stringify(
        {
          questions: QUESTIONS.length,
          byMeaning: { mrr: Number(byMeaningMrr.toFixed(3)), ranks: byMeaningRanks },
          anchorRecencyGenerous: {
            mrr: Number(anchorRecencyMrr.toFixed(3)),
            ranks: anchorRecencyRanks,
          },
          reference: {
            byMeaning: BY_MEANING_REFERENCE_MRR,
            anchorRecency: ANCHOR_RECENCY_BASELINE_MRR,
          },
        },
        null,
        2
      )
    );

    expect(byMeaningMrr).toBeGreaterThan(BY_MEANING_REFERENCE_MRR - 0.15);
    expect(byMeaningMrr).toBeGreaterThan(anchorRecencyMrr);
    expect(byMeaningMrr).toBeGreaterThan(ANCHOR_RECENCY_BASELINE_MRR * 2);
    // The baseline arm must not be a constant of the fixture: if every
    // question's answer sits at the same recency rank, the comparison is
    // arithmetic rather than measured. Distractor counts vary per anchor
    // precisely so this holds.
    expect(new Set(anchorRecencyRanks).size).toBeGreaterThan(1);
  });
});
