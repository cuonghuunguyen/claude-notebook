/**
 * Retrieval-only probe, no agent runs: for each "why" question, does the
 * memory surface the commit that actually explains it?
 *
 * Scores the shipped node-gated path against the by-meaning path. This is the
 * cheap half of the spike — if knowledge cannot be retrieved at all, no agent
 * comparison is worth paying for.
 */
import fs from "node:fs";
import path from "node:path";
import { closePool } from "@cognitive-memory/graph-store";
import { repoDir, resultsDir } from "./config.js";
import { QUESTIONS } from "./questions.js";
import { byMeaning, nodeGated, renderWhyContext, type ScoredExperience } from "./retrieve.js";

const cites = (hits: ScoredExperience[], sha: string): number =>
  hits.findIndex((h) => (h.experience.action ?? "").includes(sha));

async function main(): Promise<void> {
  const root = repoDir();
  const rows: Record<string, unknown>[] = [];
  const contexts: Record<string, string> = {};

  for (const q of QUESTIONS) {
    const gated = await nodeGated(q.question);
    const meaning = await byMeaning(q.question);
    const gatedRank = cites(gated, q.answerSha);
    const meaningRank = cites(meaning, q.answerSha);
    const rendered = renderWhyContext(meaning, root);
    contexts[q.id] = rendered;

    rows.push({
      id: q.id,
      answerSha: q.answerSha,
      nodeGated: { returned: gated.length, rankOfAnswer: gatedRank, found: gatedRank >= 0 },
      byMeaning: { returned: meaning.length, rankOfAnswer: meaningRank, found: meaningRank >= 0 },
      contextChars: rendered.length,
    });
    console.log(
      `${q.id.padEnd(18)} node-gated: ${String(gated.length).padStart(2)} hits, answer ${
        gatedRank >= 0 ? `#${gatedRank + 1}` : "MISSING"
      }   |   by-meaning: ${String(meaning.length).padStart(2)} hits, answer ${
        meaningRank >= 0 ? `#${meaningRank + 1}` : "MISSING"
      }`
    );
  }

  const rate = (key: "nodeGated" | "byMeaning") =>
    rows.filter((r) => (r[key] as { found: boolean }).found).length / rows.length;
  const mrr = (key: "nodeGated" | "byMeaning") =>
    rows.reduce((acc, r) => {
      const rank = (r[key] as { rankOfAnswer: number }).rankOfAnswer;
      return acc + (rank >= 0 ? 1 / (rank + 1) : 0);
    }, 0) / rows.length;

  const summary = {
    questions: rows.length,
    nodeGated: { recall: rate("nodeGated"), mrr: mrr("nodeGated") },
    byMeaning: { recall: rate("byMeaning"), mrr: mrr("byMeaning") },
    perQuestion: rows,
  };

  fs.mkdirSync(resultsDir(), { recursive: true });
  fs.writeFileSync(path.join(resultsDir(), "probe.json"), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(resultsDir(), "contexts.json"), JSON.stringify(contexts, null, 2));
  console.log(
    "\n" +
      JSON.stringify({ nodeGated: summary.nodeGated, byMeaning: summary.byMeaning }, null, 2)
  );
  await closePool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
