/**
 * The end-to-end agent comparison: does handing an agent the memory
 * system's AgentContext actually make it faster/more accurate on a real
 * codebase question than the same agent exploring cold?
 *
 * Both conditions run the same headless `claude -p` agent, same model, same
 * tool allowlist, same turn cap, cwd = the zod repo:
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
import { resultsDir } from "./config.js";
import { TASKS } from "./tasks.js";

const execFileAsync = promisify(execFile);

const MODEL = process.env["BENCH_AGENT_MODEL"] ?? "claude-haiku-4-5-20251001";
const DEFAULT_TASK_IDS = [
  "email-regex",
  "coerce",
  "discriminated-union",
  "safe-parse",
  "registry-meta",
  "standard-schema",
];

interface AgentRun {
  taskId: string;
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
  const zodRepo = process.env["ZOD_DIR"];
  if (!zodRepo) throw new Error("ZOD_DIR must point at the zod clone");

  const contextsPath =
    process.env["BENCH_CONTEXTS"] ?? path.join(resultsDir(), "contexts-system-heuristic.json");
  const contexts = JSON.parse(fs.readFileSync(contextsPath, "utf8")) as Record<string, string>;

  const taskIds = (process.env["BENCH_AGENT_TASKS"]?.split(",") ?? DEFAULT_TASK_IDS).map((s) => s.trim());
  const tasks = TASKS.filter((t) => taskIds.includes(t.id));

  const instruction =
    "Answer concisely. Name the exact source file path(s) under packages/zod/src/v4 " +
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
      const res = await runAgent(prompt, zodRepo);
      const answer = res.result ?? "";
      runs.push({
        taskId: task.id,
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
  const summarize = (condition: "bare" | "memory") => {
    const subset = runs.filter((r) => r.condition === condition);
    return {
      meanFileScore: mean(subset.map((r) => r.fileScore)),
      meanSymbolScore: mean(subset.map((r) => r.symbolScore)),
      meanDurationMs: mean(subset.map((r) => r.durationMs)),
      meanTurns: mean(subset.map((r) => r.numTurns)),
      totalCostUsd: subset.reduce((a, r) => a + (r.costUsd ?? 0), 0),
    };
  };

  const output = {
    model: MODEL,
    contextsPath,
    bare: summarize("bare"),
    memory: summarize("memory"),
    runs,
  };
  fs.mkdirSync(resultsDir(), { recursive: true });
  fs.writeFileSync(path.join(resultsDir(), "agent-compare.json"), JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ bare: output.bare, memory: output.memory }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
