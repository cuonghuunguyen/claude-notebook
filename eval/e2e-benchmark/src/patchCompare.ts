/**
 * Layer 4 runner: the same headless agent fixes the same seeded regression
 * with and without the memory system's context, and the fix is graded by
 * executing it.
 *
 * Each (task, condition) pair gets its own pristine copy of the target clone,
 * so the two conditions never see each other's edits and a failed run can't
 * poison the next one. Per run:
 *
 *   1. copy the clone, apply the seeded one-line regression
 *   2. assert the verification script actually FAILS (the bug is live)
 *   3. run the agent with Read/Grep/Glob/Edit, cwd = the copy
 *   4. re-run the verification script: pass/fail is the score
 *   5. diff the copy against the seeded state to see which files it touched
 *
 * Cost/turns/duration come from the CLI's JSON output, same as agentCompare.
 */
import fs from "node:fs";
import path from "node:path";
import { activeTarget, resultsDir, targetDir } from "./config.js";
import {
  MODEL,
  applySeed,
  assertSeedIsLive,
  bugPrompt,
  cleanup,
  detectAndRestoreEscape,
  filesTouched,
  makeWorkingCopy,
  rewriteRoot,
  runAgent,
  verify,
} from "./patchRunner.js";
import { PATCH_TASKS } from "./patchTasks.js";

interface PatchRun {
  taskId: string;
  condition: "bare" | "memory";
  fixed: boolean;
  touchedExpectedFile: boolean;
  filesTouched: string[];
  /** True when the agent edited the source clone instead of its own copy. */
  escapedWorkingCopy: boolean;
  verifyError: string | null;
  durationMs: number;
  numTurns: number;
  costUsd: number | null;
  answer: string;
}

async function main(): Promise<void> {
  const target = activeTarget();
  const source = targetDir(target);

  const contextsPath =
    process.env["BENCH_CONTEXTS"] ?? path.join(resultsDir(), "contexts-patch.json");
  const contexts = fs.existsSync(contextsPath)
    ? (JSON.parse(fs.readFileSync(contextsPath, "utf8")) as Record<string, string>)
    : {};

  const only = process.env["BENCH_PATCH_TASKS"]?.split(",").map((s) => s.trim());
  const tasks = only ? PATCH_TASKS.filter((t) => only.includes(t.id)) : PATCH_TASKS;

  const runs: PatchRun[] = [];
  for (const task of tasks) {
    // One seeded reference copy per task: the diff baseline for both runs.
    const seededRef = makeWorkingCopy(source, `${task.id}-ref`);
    applySeed(seededRef, task);
    await assertSeedIsLive(seededRef, task);

    for (const condition of ["bare", "memory"] as const) {
      const dir = makeWorkingCopy(source, `${task.id}-${condition}`);
      applySeed(dir, task);

      // Absolute paths in the stored context are rewritten onto this copy —
      // see rewriteRoot's comment for the failure this prevents.
      const context =
        condition === "memory"
          ? rewriteRoot(contexts[task.id] ?? "(none)", source, dir)
          : undefined;
      const res = await runAgent(bugPrompt(task.symptom, context), dir);
      const verifyError = await verify(dir, task);
      const touched = filesTouched(seededRef, dir);
      const escaped = await detectAndRestoreEscape(source);

      runs.push({
        taskId: task.id,
        condition,
        fixed: verifyError === null,
        touchedExpectedFile: task.expectedFiles.some((f) => touched.includes(f)),
        filesTouched: touched,
        escapedWorkingCopy: escaped,
        verifyError,
        durationMs: res.duration_ms ?? res.wallMs,
        numTurns: res.num_turns ?? -1,
        costUsd: res.total_cost_usd ?? null,
        answer: res.result ?? "",
      });
      const last = runs.at(-1)!;
      console.log(
        `${task.id}/${condition}: fixed=${last.fixed} touched=[${touched.join(",")}] ` +
          `turns=${last.numTurns} ${Math.round(last.durationMs / 1000)}s` +
          (escaped ? " [ESCAPED WORKING COPY — source clone restored]" : "")
      );
      cleanup(dir);
    }
    cleanup(seededRef);
  }

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  const summarize = (condition: "bare" | "memory") => {
    const subset = runs.filter((r) => r.condition === condition);
    return {
      runs: subset.length,
      fixRate: mean(subset.map((r) => (r.fixed ? 1 : 0))),
      rightFileRate: mean(subset.map((r) => (r.touchedExpectedFile ? 1 : 0))),
      meanFilesTouched: mean(subset.map((r) => r.filesTouched.length)),
      escapeRate: mean(subset.map((r) => (r.escapedWorkingCopy ? 1 : 0))),
      meanTurns: mean(subset.map((r) => r.numTurns)),
      meanDurationMs: mean(subset.map((r) => r.durationMs)),
      totalCostUsd: subset.reduce((a, r) => a + (r.costUsd ?? 0), 0),
    };
  };

  const output = {
    target: target.key,
    model: MODEL,
    contextsPath: fs.existsSync(contextsPath) ? contextsPath : null,
    bare: summarize("bare"),
    memory: summarize("memory"),
    runs,
  };
  fs.mkdirSync(resultsDir(), { recursive: true });
  fs.writeFileSync(path.join(resultsDir(), "patch-compare.json"), JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ bare: output.bare, memory: output.memory }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
