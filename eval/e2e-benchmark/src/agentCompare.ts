/**
 * The end-to-end agent comparison: does handing an agent the memory
 * system's AgentContext actually make it faster/more accurate on a real
 * codebase question than the same agent exploring cold?
 *
 * Both conditions run the same headless `claude -p` agent, same model, same
 * tool allowlist, same turn cap, cwd = the active target's clone:
 *   - bare:   question only — the agent greps/reads from scratch
 *   - memory: question + the rendered AgentContext from run.ts
 *
 * Scoring is deterministic (does the answer name the hand-labeled files and
 * symbols?); duration/turns/cost come from the CLI's JSON output.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { activeTarget, resultsDir, targetDir } from "./config.js";
import type { Hops } from "./targets/index.js";

const execFileAsync = promisify(execFile);

const MODEL = process.env["BENCH_AGENT_MODEL"] ?? "claude-haiku-4-5-20251001";

interface AgentRun {
  taskId: string;
  hops?: Hops;
  condition: "bare" | "memory";
  durationMs: number;
  numTurns: number;
  costUsd: number | null;
  fileScore: number;
  symbolScore: number;
  answer: string;
}

interface CliJson {
  result?: string;
  num_turns?: number;
  duration_ms?: number;
  total_cost_usd?: number;
}

async function runAgent(prompt: string, cwd: string): Promise<CliJson & { wallMs: number }> {
  const t0 = Date.now();
  const { stdout } = await execFileAsync(
    "claude",
    [
      "-p", prompt,
      "--model", MODEL,
      "--allowedTools", "Read,Grep,Glob",
      "--output-format", "json",
    ],
    { cwd, timeout: 420_000, maxBuffer: 16 * 1024 * 1024 }
  );
  const wallMs = Date.now() - t0;
  try {
    return { ...(JSON.parse(stdout) as CliJson), wallMs };
  } catch {
    return { result: stdout, wallMs };
  }
}

function fractionMentioned(answer: string, needles: string[]): number {
  if (needles.length === 0) return 1;
  const lower = answer.toLowerCase();
  return needles.filter((n) => lower.includes(path.basename(n).toLowerCase())).length / needles.length;
}

async function main(): Promise<void> {
  const target = activeTarget();
  const repoDir = targetDir(target);

  const contextsPath =
    process.env["BENCH_CONTEXTS"] ?? path.join(resultsDir(), "contexts-system-heuristic.json");
  const contexts = JSON.parse(fs.readFileSync(contextsPath, "utf8")) as Record<string, string>;

  const taskIds = (process.env["BENCH_AGENT_TASKS"]?.split(",") ?? target.agentTaskIds).map((s) =>
    s.trim()
  );
  const tasks = target.tasks.filter((t) => taskIds.includes(t.id));

  const instruction =
    `Answer concisely. Name ${target.agentPathHint} ` +
    "and the key symbol(s) that implement this.";

  const runs: AgentRun[] = [];
  for (const task of tasks) {
    for (const condition of ["bare", "memory"] as const) {
      const memoryBlock =
        condition === "memory"
          ? `You have a codebase memory system. Its retrieved context for this task:\n` +
            `<codebase-memory>\n${contexts[task.id] ?? "(none)"}\n</codebase-memory>\n\n`
          : "";
      const prompt = `${memoryBlock}Question about this repository: ${task.question}\n${instruction}`;
      const res = await runAgent(prompt, repoDir);
      const answer = res.result ?? "";
      runs.push({
        taskId: task.id,
        hops: task.hops,
        condition,
        durationMs: res.duration_ms ?? res.wallMs,
        numTurns: res.num_turns ?? -1,
        costUsd: res.total_cost_usd ?? null,
        fileScore: fractionMentioned(answer, task.expectedFiles),
        symbolScore: fractionMentioned(answer, task.expectedSymbols),
        answer,
      });
      console.log(
        `${task.id}/${condition}: files=${runs.at(-1)!.fileScore.toFixed(2)} ` +
          `symbols=${runs.at(-1)!.symbolScore.toFixed(2)} turns=${runs.at(-1)!.numTurns} ` +
          `${Math.round(runs.at(-1)!.durationMs / 1000)}s`
      );
    }
  }

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  const summarize = (condition: "bare" | "memory", hops?: Hops) => {
    const subset = runs.filter((r) => r.condition === condition && (!hops || r.hops === hops));
    return {
      runs: subset.length,
      meanFileScore: mean(subset.map((r) => r.fileScore)),
      meanSymbolScore: mean(subset.map((r) => r.symbolScore)),
      meanDurationMs: mean(subset.map((r) => r.durationMs)),
      meanTurns: mean(subset.map((r) => r.numTurns)),
      totalCostUsd: subset.reduce((a, r) => a + (r.costUsd ?? 0), 0),
    };
  };

  // Same single/multi-hop split as run.ts: the averaged delta hides which
  // regime the memory context actually pays for.
  const hopsBreakdown = (["single", "multi"] as const)
    .filter((h) => runs.some((r) => r.hops === h))
    .reduce<Record<string, { bare: ReturnType<typeof summarize>; memory: ReturnType<typeof summarize> }>>(
      (acc, h) => {
        acc[h] = { bare: summarize("bare", h), memory: summarize("memory", h) };
        return acc;
      },
      {}
    );

  const output = {
    target: target.key,
    model: MODEL,
    contextsPath,
    bare: summarize("bare"),
    memory: summarize("memory"),
    byHops: Object.keys(hopsBreakdown).length > 0 ? hopsBreakdown : undefined,
    runs,
  };
  fs.mkdirSync(resultsDir(), { recursive: true });
  fs.writeFileSync(path.join(resultsDir(), "agent-compare.json"), JSON.stringify(output, null, 2));
  console.log(
    JSON.stringify(
      { target: output.target, bare: output.bare, memory: output.memory, byHops: output.byHops },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
