/**
 * Shared plumbing for the two benchmark layers that make an agent actually
 * change code (patchCompare.ts and sessionChain.ts): pristine working copies,
 * seeding a regression, executing the verification script, diffing what the
 * agent touched, and driving the headless CLI.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { PatchTask } from "./patchTasks.js";

const execFileAsync = promisify(execFile);

export const MODEL = process.env["BENCH_AGENT_MODEL"] ?? "claude-haiku-4-5-20251001";
const VERIFY_FILE = "__bench_verify.mjs";

export interface CliResult {
  result?: string;
  num_turns?: number;
  duration_ms?: number;
  total_cost_usd?: number;
  wallMs: number;
}

/** A pristine copy of the target clone, minus its .git, in a temp dir. */
export function makeWorkingCopy(source: string, label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bench-${label}-`));
  fs.cpSync(source, dir, {
    recursive: true,
    filter: (src) => !src.split(path.sep).includes(".git"),
  });
  return dir;
}

export function applySeed(dir: string, task: PatchTask): void {
  const file = path.join(dir, task.brokenFile);
  const before = fs.readFileSync(file, "utf8");
  const occurrences = before.split(task.find).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `seed anchor for ${task.id} matched ${occurrences} times in ${task.brokenFile} (need exactly 1)`
    );
  }
  fs.writeFileSync(file, before.replace(task.find, task.replace));
}

/** null when the verification script passes, else its failure output. */
export async function verify(dir: string, task: PatchTask): Promise<string | null> {
  const file = path.join(dir, VERIFY_FILE);
  fs.writeFileSync(file, task.verify);
  try {
    await execFileAsync("node", [file], { cwd: dir, timeout: 60_000 });
    return null;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return (e.stderr || e.message || "verification failed").split("\n").slice(0, 6).join("\n");
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/**
 * Guards against a seeded regression that silently no-ops (e.g. neutralising
 * a tie-break that V8's stable sort makes redundant anyway) — such a task
 * would grade as a free pass for both conditions and quietly inflate the
 * result. Called before every run.
 */
export async function assertSeedIsLive(dir: string, task: PatchTask): Promise<void> {
  if ((await verify(dir, task)) === null) {
    throw new Error(
      `seeded regression for ${task.id} does not break its own verification — ` +
        `the task would grade as a free pass`
    );
  }
}

/** Files whose content differs between the seeded copy and the agent's copy. */
export function filesTouched(seededDir: string, agentDir: string): string[] {
  const touched: string[] = [];
  for (const entry of fs.readdirSync(agentDir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name === VERIFY_FILE) continue;
    const before = path.join(seededDir, entry.name);
    const after = path.join(agentDir, entry.name);
    if (!fs.existsSync(before)) {
      touched.push(entry.name);
      continue;
    }
    if (fs.readFileSync(before, "utf8") !== fs.readFileSync(after, "utf8")) touched.push(entry.name);
  }
  return touched;
}

export async function runAgent(prompt: string, cwd: string): Promise<CliResult> {
  const t0 = Date.now();
  const { stdout } = await execFileAsync(
    "claude",
    [
      "-p", prompt,
      "--model", MODEL,
      "--allowedTools", "Read,Grep,Glob,Edit",
      "--permission-mode", "acceptEdits",
      "--output-format", "json",
    ],
    { cwd, timeout: 600_000, maxBuffer: 16 * 1024 * 1024 }
  );
  const wallMs = Date.now() - t0;
  try {
    return { ...(JSON.parse(stdout) as Omit<CliResult, "wallMs">), wallMs };
  } catch {
    return { result: stdout, wallMs };
  }
}

/**
 * The rendered AgentContext contains the *absolute* paths recorded at ingest
 * time (buildContext copies `node.path` verbatim, and the extractor stores
 * ts-morph's absolute file paths). Handed to an agent working in a different
 * checkout, those paths point outside its working directory — and an agent
 * with Edit will follow them: the first run of this layer had the agent patch
 * the pristine clone instead of its own copy, so its fix "vanished".
 *
 * Rewriting the prefix is what any real integrator would have to do. The
 * unrewritten behaviour is reported as a finding rather than hidden by this.
 */
export function rewriteRoot(context: string, fromRoot: string, toRoot: string): string {
  return context.split(fromRoot).join(toRoot);
}

/**
 * Detects a run that escaped its working copy and edited the source clone,
 * then restores the clone. Returns true if an escape happened — the numbers
 * for that run are about path handling, not about finding the bug, and the
 * report says so.
 */
export async function detectAndRestoreEscape(sourceRepo: string): Promise<boolean> {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd: sourceRepo });
  if (stdout.trim() === "") return false;
  await execFileAsync("git", ["checkout", "--", "."], { cwd: sourceRepo });
  return true;
}

export function memoryBlock(context: string | undefined): string {
  if (!context) return "";
  return (
    `You have a codebase memory system. Its retrieved context for this task:\n` +
    `<codebase-memory>\n${context}\n</codebase-memory>\n\n`
  );
}

export function bugPrompt(symptom: string, context?: string): string {
  return (
    `${memoryBlock(context)}Bug report for this repository: ${symptom}\n` +
    `Edit the source to fix it. Change as little as possible and do not add new files. ` +
    `When done, state which file you changed and why.`
  );
}

export function cleanup(dir: string): void {
  if (process.env["BENCH_KEEP_COPIES"] !== "1") fs.rmSync(dir, { recursive: true, force: true });
}
