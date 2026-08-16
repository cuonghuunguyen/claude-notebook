/**
 * Produces the memory context handed to the "memory" condition of the
 * code-change layer: runPipeline over each patch task's *symptom* (the same
 * text the agent gets), rendered exactly as an agent would receive it.
 *
 * Kept separate from patchCompare.ts so the agent runner never touches
 * Postgres — and so a context set can be generated once and reused across
 * repeated agent runs.
 */
import fs from "node:fs";
import path from "node:path";
import { renderContext } from "@cognitive-memory/context";
import { closePool } from "@cognitive-memory/graph-store";
import { runPipeline } from "@cognitive-memory/pipeline";
import { createFakeEmbedder } from "@cognitive-memory/retrieval";
import { createPostgresGraphProvider } from "@cognitive-memory/traversal";
import { activeTarget, resultsDir } from "./config.js";
import { createHeuristicReasoner } from "./reasoners.js";
import { FOLLOW_UP_TASKS, PATCH_TASKS } from "./patchTasks.js";

async function main(): Promise<void> {
  const target = activeTarget();
  const embedder = createFakeEmbedder();
  const graph = createPostgresGraphProvider();
  // Heuristic (non-LLM) reasoner: the code-change layer varies the agent, not
  // the traversal policy, so the cheap deterministic one keeps contexts stable.
  const reasoner = createHeuristicReasoner();

  const contexts: Record<string, string> = {};
  const summary: Record<string, { chars: number; files: string[]; hitsExpected: boolean }> = {};

  for (const task of [...PATCH_TASKS, ...FOLLOW_UP_TASKS]) {
    const { context } = await runPipeline(task.symptom, {
      repoId: target.repoId,
      embedder,
      graph,
      reasoner,
      contextOptions: { maxSourceFiles: 10 },
    });
    const rendered = renderContext(context);
    contexts[task.id] = rendered;
    const files = context.sourceFiles.map((f) => path.basename(f.path));
    const hitsExpected = task.expectedFiles.some((e) => files.includes(e));
    summary[task.id] = { chars: rendered.length, files, hitsExpected };
    console.log(
      `${task.id}: ${rendered.length} chars, points at expected fix site: ${hitsExpected}`
    );
  }

  fs.mkdirSync(resultsDir(), { recursive: true });
  fs.writeFileSync(path.join(resultsDir(), "contexts-patch.json"), JSON.stringify(contexts, null, 2));
  fs.writeFileSync(
    path.join(resultsDir(), "contexts-patch-summary.json"),
    JSON.stringify(summary, null, 2)
  );
  await closePool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
