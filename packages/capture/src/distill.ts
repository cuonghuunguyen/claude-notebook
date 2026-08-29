/**
 * Distillation (spec.md §26 / ROADMAP.md M19).
 *
 * A mined memory is a raw commit body: the right content, in the wrong shape
 * for retrieval. The 2026-08-28 real-prompt replay measured what that costs —
 * a median 3.9 KB injected per fired prompt after calibration, cited by 4 of 19
 * answers, and a judge tally the memory arm lost 11/6/2 (BENCHMARKS.md). This
 * rewrites each body once, at sync time, into a short what/why/where summary,
 * and points every retrieval leg at that instead.
 *
 * `observation` is never touched (§8 append-only). `digest` is derived, like
 * `embedding`: reproducible from the body, and `UPDATE experiences SET digest =
 * NULL` reverts the system to raw-body retrieval with nothing else to undo.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Experience } from "@cognitive-memory/core";
import { listExperiencesMissingDigest, setExperienceDigest } from "@cognitive-memory/graph-store";

const execFileAsync = promisify(execFile);

/**
 * A digest longer than this is not a digest. The prompt asks for ≤120 words;
 * 1200 chars is roughly double that, so the check only catches a runner that
 * ignored the instruction (echoed the body back, wrote an essay, emitted a
 * refusal preamble plus the text), not one that merely ran long.
 */
const MAX_DIGEST_CHARS = 1200;

/** Enough of the body to reason about; beyond this a commit is a diff dump, not an explanation. */
const MAX_PROMPT_BODY_CHARS = 12_000;

/** Thrown when `claude` is not on PATH, so the CLI can degrade to "skipped" instead of failing `sync`. */
export class ClaudeCliMissingError extends Error {
  constructor() {
    super("`claude` is not on PATH — cannot distill memories");
    this.name = "ClaudeCliMissingError";
  }
}

/** Injected so the distillation pass is testable without spending money or needing a CLI. */
export type DistillRunner = (prompt: string) => Promise<string>;

export interface DistillOptions {
  runner: DistillRunner;
  /** Memories per pass. The default bounds one `sync`'s LLM spend; a larger corpus finishes over several syncs. */
  limit?: number;
  /**
   * Memories in flight at once. Not a throughput knob for its own sake: a
   * `claude -p --model haiku` call was measured at ~27 s wall on a trivial
   * prompt, which is process startup, not inference. Sequentially that is ~1.8 h
   * for a 215-memory corpus and ~25 min at 4. Token spend is identical either
   * way — the same calls, overlapped.
   *
   * ponytail: fixed-size worker loop over an index, no queue library. Raise it
   * if a provider's rate limit is the binding constraint rather than startup.
   */
  concurrency?: number;
}

export interface DistillResult {
  distilled: number;
  /** Rows whose runner output was empty or over `MAX_DIGEST_CHARS`. Their `digest` stays NULL, so the next pass retries them. */
  skipped: number;
}

export function distillPrompt(experience: Experience): string {
  const paths = (experience.anchors ?? []).map((a) => a.path);
  const body = experience.observation.slice(0, MAX_PROMPT_BODY_CHARS);
  return [
    "Summarize this software-engineering memory so another engineer can decide in five seconds whether it answers their question.",
    "",
    `TASK: ${experience.task}`,
    `FILES: ${paths.length > 0 ? paths.join(", ") : "(none recorded)"}`,
    "BODY:",
    body,
    "",
    "Rules:",
    "- At most 120 words total.",
    "- Exactly three lines, each starting with one of these labels: `What:`, `Why:`, `Where:`.",
    "- `What:` what was changed or decided. `Why:` the reason, including what was rejected and why, if the body says.",
    "- `Where:` only the FILES above that actually matter to the change, verbatim, comma-separated.",
    "- Plain text. No markdown, no bullet points, no code fences, no preamble, no closing remark.",
    "- If the body explains nothing, still emit the three lines from what it does say.",
  ].join("\n");
}

/**
 * Distills every memory that has no digest yet.
 *
 * Idempotent by the same rule capture is: the worklist is
 * `digest IS NULL`, so a re-run after a completed pass does nothing, and a run
 * interrupted halfway resumes where it stopped. A skipped row keeps a NULL
 * digest deliberately — it stays retrievable by its raw body and gets another
 * chance next sync, which is the right failure mode for a transient LLM error.
 */
export async function distillExperiences(options: DistillOptions): Promise<DistillResult> {
  const pending = await listExperiencesMissingDigest(options.limit ?? 200);
  let next = 0;
  let distilled = 0;
  let skipped = 0;

  // A shared cursor rather than a chunked split, so one slow memory does not
  // idle the other workers. The writes serialize on the single SQLite
  // connection anyway; what overlaps is the LLM call.
  const worker = async (): Promise<void> => {
    for (let i = next++; i < pending.length; i = next++) {
      const experience = pending[i] as Experience;
      const digest = (await options.runner(distillPrompt(experience))).trim();
      if (!digest || digest.length > MAX_DIGEST_CHARS) {
        skipped += 1;
        continue;
      }
      await setExperienceDigest(experience.id, digest);
      distilled += 1;
    }
  };

  const workers = Math.max(1, Math.min(options.concurrency ?? 4, pending.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return { distilled, skipped };
}

export interface ClaudeCliRunnerOptions {
  /** Haiku by default: this is a summarization job over text the corpus already contains, run once per memory for the life of that memory. */
  model?: string;
  /** 120 s, not 60: the call is ~27 s of CLI startup before any inference, and several run concurrently. */
  timeoutMs?: number;
}

/**
 * The shipped runner: one `claude -p` call per memory.
 *
 * `--allowedTools ""` because the prompt carries everything the model needs —
 * a tool-using run would read the repository, cost several times as much, and
 * could put content into the digest that the memory does not actually say.
 */
export function createClaudeCliRunner(options: ClaudeCliRunnerOptions = {}): DistillRunner {
  const model = options.model ?? "haiku";
  const timeout = options.timeoutMs ?? 120_000;
  return async (prompt: string) => {
    try {
      const { stdout } = await execFileAsync(
        "claude",
        ["-p", prompt, "--model", model, "--output-format", "text", "--allowedTools", ""],
        { timeout, maxBuffer: 8 * 1024 * 1024 }
      );
      return stdout.trim();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new ClaudeCliMissingError();
      // Any other failure (timeout, non-zero exit, a model refusal) is one
      // memory's problem, not the pass's: return nothing and let it be skipped.
      //
      // Reported on stderr rather than swallowed, because a *silent* skip is
      // indistinguishable from a bad summary. This run hit a usage limit
      // mid-pass and 85 memories were skipped with no signal beyond the count
      // in the final JSON; one line each would have named the cause
      // immediately, and the pass is already minutes long per memory.
      console.error(`distill: ${(err as Error).message.split("\n")[0]}`);
      return "";
    }
  };
}
