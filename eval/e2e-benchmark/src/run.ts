/**
 * The retrieval-quality benchmark: for every task in tasks.ts, run the full
 * runPipeline (retrieval → traversal → context) against the ingested zod v4
 * graph and score the files it surfaces against hand-labeled ground truth,
 * next to the naive-keyword baseline an agent without memory would use.
 *
 * Variants:
 *   - system-heuristic: score-threshold reasoner (no LLM)
 *   - system-claude:    real `claude` CLI reasoner (set BENCH_REASONER=claude)
 *   - baseline:         keyword file search over the same indexed scope
 */
import fs from "node:fs";
import path from "node:path";
import { renderContext } from "@cognitive-memory/context";
import { closePool } from "@cognitive-memory/graph-store";
import { runPipeline } from "@cognitive-memory/pipeline";
import { createFakeEmbedder } from "@cognitive-memory/retrieval";
import { createPostgresGraphProvider } from "@cognitive-memory/traversal";
import { baselineSearch } from "./baseline.js";
import { REPO_ID, resultsDir, sourceGlobs, zodRoot } from "./config.js";
import { createClaudeReasoner, createHeuristicReasoner } from "./reasoners.js";
import { TASKS } from "./tasks.js";

const TOP_K = 10;

interface TaskScore {
  taskId: string;
  question: string;
  expectedFiles: string[];
  predictedFiles: string[];
  recallAtK: number;
  mrr: number;
  hitAt1: boolean;
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

function listIndexedFiles(): string[] {
  const root = zodRoot();
  const files: string[] = [];
  for (const dir of ["classic", "core"]) {
    const base = path.join(root, dir);
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path.join(base, entry.name));
    }
  }
  return files;
}

async function main(): Promise<void> {
  const useClaude = process.env["BENCH_REASONER"] === "claude";
  const variant = useClaude ? "system-claude" : "system-heuristic";
  const reasoner = useClaude ? createClaudeReasoner() : createHeuristicReasoner();
  const embedder = createFakeEmbedder();
  const graph = createPostgresGraphProvider();
  const indexedFiles = listIndexedFiles();

  const systemScores: TaskScore[] = [];
  const baselineScores: TaskScore[] = [];
  const renderedContexts: Record<string, string> = {};

  for (const task of TASKS) {
    const t0 = Date.now();
    const { context, seeds, traversal } = await runPipeline(task.question, {
      repoId: REPO_ID,
      embedder,
      graph,
      reasoner,
      contextOptions: { maxSourceFiles: TOP_K },
    });
    const latencyMs = Date.now() - t0;

    const predicted = context.sourceFiles.map((f) => f.path);
    const rendered = renderContext(context);
    renderedContexts[task.id] = rendered;
    systemScores.push({
      taskId: task.id,
      question: task.question,
      expectedFiles: task.expectedFiles,
      predictedFiles: predicted,
      ...score(predicted, task.expectedFiles),
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
    baselineScores.push({
      taskId: task.id,
      question: task.question,
      expectedFiles: task.expectedFiles,
      predictedFiles: baselinePredicted,
      ...score(baselinePredicted, task.expectedFiles),
      latencyMs: Date.now() - b0,
      seeds: 0,
      traversedNodes: 0,
      reasoningSteps: 0,
      stopReason: "n/a",
      contextChars: 0,
      experiencesSurfaced: 0,
    });
    console.log(
      `${task.id}: system recall@${TOP_K}=${systemScores.at(-1)!.recallAtK.toFixed(2)} ` +
        `baseline recall@${TOP_K}=${baselineScores.at(-1)!.recallAtK.toFixed(2)} ` +
        `(${latencyMs}ms, ${traversal.nodeIds.length} nodes, stop=${traversal.stopReason})`
    );
  }

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  const aggregate = (scores: TaskScore[]) => ({
    meanRecallAtK: mean(scores.map((s) => s.recallAtK)),
    meanMrr: mean(scores.map((s) => s.mrr)),
    hitAt1Rate: mean(scores.map((s) => (s.hitAt1 ? 1 : 0))),
    meanLatencyMs: mean(scores.map((s) => s.latencyMs)),
    meanContextChars: mean(scores.map((s) => s.contextChars)),
  });

  const output = {
    variant,
    topK: TOP_K,
    tasks: TASKS.length,
    sourceScope: sourceGlobs(zodRoot()),
    reasonerStats: useClaude ? (reasoner as ReturnType<typeof createClaudeReasoner>).stats : undefined,
    system: { aggregate: aggregate(systemScores), perTask: systemScores },
    baseline: { aggregate: aggregate(baselineScores), perTask: baselineScores },
  };

  fs.mkdirSync(resultsDir(), { recursive: true });
  fs.writeFileSync(path.join(resultsDir(), `run-${variant}.json`), JSON.stringify(output, null, 2));
  fs.writeFileSync(
    path.join(resultsDir(), `contexts-${variant}.json`),
    JSON.stringify(renderedContexts, null, 2)
  );
  console.log(JSON.stringify({ variant, system: output.system.aggregate, baseline: output.baseline.aggregate }, null, 2));
  await closePool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
