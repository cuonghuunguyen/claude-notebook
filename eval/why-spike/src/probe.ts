/**
 * Retrieval-only probe, no agent runs: for each "why" question, does the
 * memory surface the commit that actually explains it?
 *
 * Scores the shipped by-meaning path (spec.md §24.2.1). Until M15 it scored
 * that against the pre-M11 node-gated path on the same questions; that arm
 * retired with the structural graph, and its final numbers — 0.00 MRR with the
 * graph fully populated and 0.00 with it empty, against by-meaning's 0.85 in
 * both — are in `BENCHMARKS.md` as M15's gate.
 *
 * This is the cheap half of the spike: if knowledge cannot be retrieved at all,
 * no agent comparison is worth paying for.
 */
import fs from "node:fs";
import path from "node:path";
import { closeDb, useScratchDatabase } from "@cognitive-memory/graph-store";
import { repoDir, resultsDir } from "./config.js";
import { QUESTIONS } from "./questions.js";
import { byMeaning, renderWhyContext, type ScoredExperience } from "./retrieve.js";

const cites = (hits: ScoredExperience[], sha: string): number =>
  hits.findIndex((h) => (h.experience.action ?? "").includes(sha));

async function main(): Promise<void> {
  await useScratchDatabase("why-spike");
  const root = repoDir();
  const rows: Record<string, unknown>[] = [];
  const contexts: Record<string, string> = {};

  for (const q of QUESTIONS) {
    const meaning = await byMeaning(q.question);
    const meaningRank = cites(meaning, q.answerSha);
    const rendered = renderWhyContext(meaning, root);
    contexts[q.id] = rendered;

    rows.push({
      id: q.id,
      answerSha: q.answerSha,
      byMeaning: { returned: meaning.length, rankOfAnswer: meaningRank, found: meaningRank >= 0 },
      contextChars: rendered.length,
    });
    console.log(
      `${q.id.padEnd(18)} by-meaning: ${String(meaning.length).padStart(2)} hits, answer ${
        meaningRank >= 0 ? `#${meaningRank + 1}` : "MISSING"
      }`
    );
  }

  const rate = () => rows.filter((r) => (r["byMeaning"] as { found: boolean }).found).length / rows.length;
  const mrr = () =>
    rows.reduce((acc, r) => {
      const rank = (r["byMeaning"] as { rankOfAnswer: number }).rankOfAnswer;
      return acc + (rank >= 0 ? 1 / (rank + 1) : 0);
    }, 0) / rows.length;

  const summary = {
    questions: rows.length,
    byMeaning: { recall: rate(), mrr: mrr() },
    perQuestion: rows,
  };

  fs.mkdirSync(resultsDir(), { recursive: true });
  fs.writeFileSync(path.join(resultsDir(), "probe.json"), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(resultsDir(), "contexts.json"), JSON.stringify(contexts, null, 2));
  console.log("\n" + JSON.stringify({ byMeaning: summary.byMeaning }, null, 2));
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
