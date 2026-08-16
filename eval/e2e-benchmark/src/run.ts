/**
 * The retrieval-quality benchmark: for every task in the active target, run
 * the full runPipeline (retrieval → traversal → context) against the ingested
 * graph and score the files it surfaces against hand-labeled ground truth,
 * next to the naive-keyword baseline an agent without memory would use.
 *
 * Variants:
 *   - system-heuristic: score-threshold reasoner (no LLM)
 *   - system-claude:    real `claude` CLI reasoner (set BENCH_REASONER=claude)
 *   - baseline:         keyword file search over the same indexed scope
 *
 * Results are also aggregated per `hops` group where the target's question set
 * defines one, because the averaged number hides the finding: grep and graph
 * memory are strong in different regimes, and the split is what shows it.
 */
import fs from "node:fs";
import path from "node:path";
import { renderContext } from "@cognitive-memory/context";
import { closePool, getNodesByIds } from "@cognitive-memory/graph-store";
import { runPipeline } from "@cognitive-memory/pipeline";
import { createFakeEmbedder } from "@cognitive-memory/retrieval";
import { createPostgresGraphProvider } from "@cognitive-memory/traversal";
import { baselineSearch } from "./baseline.js";
import { activeTarget, resultsDir, targetRoot } from "./config.js";
import { createClaudeReasoner, createHeuristicReasoner } from "./reasoners.js";
import type { Hops } from "./targets/index.js";

const TOP_K = 10;

interface TaskScore {
  taskId: string;
  question: string;
  hops?: Hops;
  expectedFiles: string[];
  /** Files as the agent receives them in the AgentContext. */
  predictedFiles: string[];
  /**
   * The same result in the system's own relevance order (traversal discovery
   * order). `predictedFiles` cannot be used to measure ranking: buildContext
   * truncates by relevance and then sorts the survivors alphabetically for
   * display, so any MRR/hit@1 computed over it is really measuring the
   * alphabet. Recall is a set membership test and is unaffected.
   */
  rankedFiles: string[];
  recallAtK: number;
  /** MRR/hit@1 over `predictedFiles` — retained only to show the artefact. */
  mrr: number;
  hitAt1: boolean;
  /** The honest ranking metrics, over `rankedFiles`. */
  rankedRecallAtK: number;
  rankedMrr: number;
  rankedHitAt1: boolean;
  latencyMs: number;
  seeds: number;
  traversedNodes: number;
  reasoningSteps: number;
  stopReason: string;
  contextChars: number;
  experiencesSurfaced: number;
}

function score(predicted: string[], expected: string[]): Pick<TaskScore, "recallAtK" | "mrr" | "hitAt1"> {
  const topK = predicted.slice(0, TOP_K);
  const matched = expected.filter((e) => topK.some((p) => p.endsWith(e)));
  const firstRank = topK.findIndex((p) => expected.some((e) => p.endsWith(e)));
  return {
    recallAtK: expected.length === 0 ? 1 : matched.length / expected.length,
    mrr: firstRank === -1 ? 0 : 1 / (firstRank + 1),
    hitAt1: firstRank === 0,
  };
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

function aggregate(scores: TaskScore[]) {
  return {
    tasks: scores.length,
    meanRecallAtK: mean(scores.map((s) => s.recallAtK)),
    meanMrr: mean(scores.map((s) => s.mrr)),
    hitAt1Rate: mean(scores.map((s) => (s.hitAt1 ? 1 : 0))),
    meanRankedRecallAtK: mean(scores.map((s) => s.rankedRecallAtK)),
    meanRankedMrr: mean(scores.map((s) => s.rankedMrr)),
    rankedHitAt1Rate: mean(scores.map((s) => (s.rankedHitAt1 ? 1 : 0))),
    meanLatencyMs: mean(scores.map((s) => s.latencyMs)),
    meanContextChars: mean(scores.map((s) => s.contextChars)),
  };
}

/**
 * Distinct file paths in traversal discovery order — the priority order the
 * pipeline itself documents as its relevance signal, before buildContext
 * re-sorts for display. Function/class nodes contribute their own file.
 */
async function rankedFilesFor(nodeIds: string[]): Promise<string[]> {
  if (nodeIds.length === 0) return [];
  const nodes = await getNodesByIds(nodeIds);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const id of nodeIds) {
    const filePath = byId.get(id)?.path;
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    ordered.push(filePath);
  }
  return ordered;
}

/** Per-hops aggregates, only for targets whose question set labels them. */
function byHops(scores: TaskScore[]): Record<string, ReturnType<typeof aggregate>> | undefined {
  const labeled = scores.filter((s) => s.hops);
  if (labeled.length === 0) return undefined;
  const out: Record<string, ReturnType<typeof aggregate>> = {};
  for (const hops of ["single", "multi"] as const) {
    const subset = labeled.filter((s) => s.hops === hops);
    if (subset.length > 0) out[hops] = aggregate(subset);
  }
  return out;
}

async function main(): Promise<void> {
  const target = activeTarget();
  const root = targetRoot(target);
  const useClaude = process.env["BENCH_REASONER"] === "claude";
  const variant = useClaude ? "system-claude" : "system-heuristic";
  const reasoner = useClaude ? createClaudeReasoner() : createHeuristicReasoner();
  const embedder = createFakeEmbedder();
  const graph = createPostgresGraphProvider();
  const indexedFiles = target.indexedFiles(root);

  const systemScores: TaskScore[] = [];
  const baselineScores: TaskScore[] = [];
  const renderedContexts: Record<string, string> = {};

  for (const task of target.tasks) {
    const t0 = Date.now();
    const { context, seeds, traversal } = await runPipeline(task.question, {
      repoId: target.repoId,
      embedder,
      graph,
      reasoner,
      contextOptions: { maxSourceFiles: TOP_K },
    });
    const latencyMs = Date.now() - t0;

    const predicted = context.sourceFiles.map((f) => f.path);
    const ranked = await rankedFilesFor(traversal.nodeIds);
    const rankedScore = score(ranked, task.expectedFiles);
    const rendered = renderContext(context);
    renderedContexts[task.id] = rendered;
    systemScores.push({
      taskId: task.id,
      question: task.question,
      hops: task.hops,
      expectedFiles: task.expectedFiles,
      predictedFiles: predicted,
      rankedFiles: ranked.slice(0, TOP_K),
      ...score(predicted, task.expectedFiles),
      rankedRecallAtK: rankedScore.recallAtK,
      rankedMrr: rankedScore.mrr,
      rankedHitAt1: rankedScore.hitAt1,
      latencyMs,
      seeds: seeds.length,
      traversedNodes: traversal.nodeIds.length,
      reasoningSteps: traversal.reasoningStepsUsed,
      stopReason: traversal.stopReason,
      contextChars: rendered.length,
      experiencesSurfaced: context.experiences.length,
    });

    const b0 = Date.now();
    const baselinePredicted = baselineSearch(task.question, indexedFiles, TOP_K).map((h) => h.path);
    const baselineScore = score(baselinePredicted, task.expectedFiles);
    baselineScores.push({
      taskId: task.id,
      question: task.question,
      hops: task.hops,
      expectedFiles: task.expectedFiles,
      predictedFiles: baselinePredicted,
      // The baseline emits one genuinely score-ordered list; both columns are
      // the same list so the two are compared like for like.
      rankedFiles: baselinePredicted,
      ...baselineScore,
      rankedRecallAtK: baselineScore.recallAtK,
      rankedMrr: baselineScore.mrr,
      rankedHitAt1: baselineScore.hitAt1,
      latencyMs: Date.now() - b0,
      seeds: 0,
      traversedNodes: 0,
      reasoningSteps: 0,
      stopReason: "n/a",
      contextChars: 0,
      experiencesSurfaced: 0,
    });
    console.log(
      `${task.id} [${task.hops ?? "-"}]: system recall@${TOP_K}=${systemScores.at(-1)!.recallAtK.toFixed(2)} ` +
        `baseline recall@${TOP_K}=${baselineScores.at(-1)!.recallAtK.toFixed(2)} ` +
        `(${latencyMs}ms, ${traversal.nodeIds.length} nodes, stop=${traversal.stopReason})`
    );
  }

  const output = {
    target: target.key,
    variant,
    topK: TOP_K,
    tasks: target.tasks.length,
    sourceScope: target.sourceGlobs(root),
    indexedFileCount: indexedFiles.length,
    reasonerStats: useClaude ? (reasoner as ReturnType<typeof createClaudeReasoner>).stats : undefined,
    system: { aggregate: aggregate(systemScores), byHops: byHops(systemScores), perTask: systemScores },
    baseline: {
      aggregate: aggregate(baselineScores),
      byHops: byHops(baselineScores),
      perTask: baselineScores,
    },
  };

  fs.mkdirSync(resultsDir(), { recursive: true });
  fs.writeFileSync(path.join(resultsDir(), `run-${variant}.json`), JSON.stringify(output, null, 2));
  fs.writeFileSync(
    path.join(resultsDir(), `contexts-${variant}.json`),
    JSON.stringify(renderedContexts, null, 2)
  );
  console.log(
    JSON.stringify(
      {
        target: target.key,
        variant,
        system: output.system.aggregate,
        systemByHops: output.system.byHops,
        baseline: output.baseline.aggregate,
        baselineByHops: output.baseline.byHops,
      },
      null,
      2
    )
  );
  await closePool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
