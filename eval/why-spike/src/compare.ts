/**
 * The honest A/B for a "memory of why".
 *
 * The baseline is NOT an agent with grep — that would be a strawman here,
 * because the knowledge genuinely isn't in the code. The baseline is an agent
 * with **full read access to the git history**: `git log`, `git show`,
 * `git blame`, `git grep`. It can mine exactly the same commits this memory
 * was built from.
 *
 * So the question this measures is precise: is a *precomputed, curated,
 * code-bound* memory worth anything against an agent that can go and find the
 * same history on demand? If it isn't, the direction is wrong regardless of
 * how good retrieval looks in isolation.
 *
 * Grading is deterministic: each question carries synonym groups drawn from
 * the real commit message, and an answer scores the fraction of groups it
 * mentions. Citing the commit sha is tracked separately.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { closePool } from "@cognitive-memory/graph-store";
import { repoDir, resultsDir } from "./config.js";
import { QUESTIONS, type WhyQuestion } from "./questions.js";
import { byMeaning, renderWhyContext } from "./retrieve.js";

const execFileAsync = promisify(execFile);

const MODEL = process.env["SPIKE_MODEL"] ?? "claude-haiku-4-5-20251001";
const TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(git blame:*)",
  "Bash(git grep:*)",
].join(",");

interface Run {
  id: string;
  condition: "git-only" | "memory";
  score: number;
  groupsHit: number;
  groupsTotal: number;
  citedSha: boolean;
  numTurns: number;
  durationMs: number;
  costUsd: number | null;
  answer: string;
}

function grade(answer: string, q: WhyQuestion): { score: number; hit: number } {
  const lower = answer.toLowerCase();
  const hit = q.mustMention.filter((group) => group.some((v) => lower.includes(v.toLowerCase()))).length;
  return { score: hit / q.mustMention.length, hit };
}

async function runAgent(prompt: string, cwd: string) {
  const t0 = Date.now();
  const { stdout } = await execFileAsync(
    "claude",
    ["-p", prompt, "--model", MODEL, "--allowedTools", TOOLS, "--output-format", "json"],
    { cwd, timeout: 600_000, maxBuffer: 32 * 1024 * 1024 }
  );
  const wallMs = Date.now() - t0;
  try {
    return {
      ...(JSON.parse(stdout) as {
        result?: string;
        num_turns?: number;
        duration_ms?: number;
        total_cost_usd?: number;
      }),
      wallMs,
    };
  } catch {
    return { result: stdout, wallMs };
  }
}

async function main(): Promise<void> {
  const root = repoDir();
  const only = process.env["SPIKE_QUESTIONS"]?.split(",").map((s) => s.trim());
  const questions = only ? QUESTIONS.filter((q) => only.includes(q.id)) : QUESTIONS;

  const instruction =
    "Explain the reason, not just the current behaviour. If the repository's history " +
    "explains it, say what the explanation was and cite the commit. Answer in under 150 words.";

  const runs: Run[] = [];
  for (const q of questions) {
    const hits = await byMeaning(q.question);
    const context = renderWhyContext(hits, root);

    for (const condition of ["git-only", "memory"] as const) {
      const block =
        condition === "memory"
          ? `A codebase memory system has recorded prior knowledge about this repository. ` +
            `Its retrieved records for this question:\n<recorded-knowledge>\n${context}\n</recorded-knowledge>\n\n`
          : "";
      const prompt = `${block}Question about this repository: ${q.question}\n${instruction}`;
      const res = await runAgent(prompt, root);
      const answer = res.result ?? "";
      const { score, hit } = grade(answer, q);
      runs.push({
        id: q.id,
        condition,
        score,
        groupsHit: hit,
        groupsTotal: q.mustMention.length,
        citedSha: answer.toLowerCase().includes(q.answerSha.slice(0, 7).toLowerCase()),
        numTurns: res.num_turns ?? -1,
        durationMs: res.duration_ms ?? res.wallMs,
        costUsd: res.total_cost_usd ?? null,
        answer,
      });
      const last = runs.at(-1)!;
      console.log(
        `${q.id.padEnd(18)} ${condition.padEnd(9)} score ${last.score.toFixed(2)} ` +
          `(${hit}/${q.mustMention.length}) cited=${last.citedSha ? "yes" : "no"} ` +
          `turns=${last.numTurns} ${Math.round(last.durationMs / 1000)}s`
      );
    }
  }

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  const summarize = (condition: Run["condition"]) => {
    const subset = runs.filter((r) => r.condition === condition);
    return {
      runs: subset.length,
      meanScore: mean(subset.map((r) => r.score)),
      fullyAnswered: subset.filter((r) => r.score === 1).length,
      citedShaRate: mean(subset.map((r) => (r.citedSha ? 1 : 0))),
      meanTurns: mean(subset.map((r) => r.numTurns)),
      meanDurationMs: mean(subset.map((r) => r.durationMs)),
      totalCostUsd: subset.reduce((a, r) => a + (r.costUsd ?? 0), 0),
    };
  };

  const output = {
    model: MODEL,
    baseline: "agent with full git history access (log/show/blame/grep)",
    "git-only": summarize("git-only"),
    memory: summarize("memory"),
    runs,
  };
  fs.mkdirSync(resultsDir(), { recursive: true });
  fs.writeFileSync(path.join(resultsDir(), "compare.json"), JSON.stringify(output, null, 2));
  console.log(
    "\n" + JSON.stringify({ gitOnly: output["git-only"], memory: output.memory }, null, 2)
  );
  await closePool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
