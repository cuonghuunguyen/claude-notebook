/**
 * Idempotent persistence for the git-history miner (spec.md §24.2.1,
 * ROADMAP.md M11).
 *
 * The contract is the one `scripts/self-memory.mjs sync` already had and that
 * M11 promotes into a package: **re-running over the same history writes
 * nothing new**. Without it, capture is unusable in a loop — every sync after
 * a merge would duplicate every previously-mined commit, and the duplicates
 * would then compete with each other in by-meaning ranking.
 *
 * Identity is the commit itself, carried in `Experience.action` as
 * `commit <shortSha>`: the same encoding `self-memory.mjs` and
 * `eval/why-spike` already wrote, so promoting this into a package does not
 * orphan the memories either of them recorded.
 */
import type { Anchor, EmbeddingProvider, Experience } from "@cognitive-memory/core";
import { recordExperience } from "@cognitive-memory/episodic";
import {
  getExperienceById,
  listExperienceActions,
  listExperienceIdsMissingEmbedding,
  upsertExperienceEmbedding,
} from "@cognitive-memory/graph-store";
import { lessonFrom, mineCommits } from "./corpus.js";

/** `Experience.action` prefix that identifies a git-mined memory. */
export const COMMIT_ACTION_PREFIX = "commit ";

export const commitAction = (shortSha: string): string =>
  `${COMMIT_ACTION_PREFIX}${shortSha}`;

/**
 * spec.md §4's evidence hierarchy puts git history below code and tests and
 * above bare LLM inference. 0.7 is the value the measured spike used; keeping
 * it identical is what makes M11's numbers comparable to
 * `WHY_MEMORY_SPIKE.md`'s.
 */
const DEFAULT_CONFIDENCE = 0.7;

export interface CaptureGitHistoryOptions {
  /** Absolute path to a full (non-shallow) clone. Shallow clones have no history to mine. */
  repoDir: string;
  /** Repo-relative path prefix to mine, e.g. `packages` or `src`. */
  pathScope: string;
  /** Max commits `git log` walks. Default 400 (the spike's value). */
  limit?: number;
  /** When given, each newly recorded memory gets an embedding for the vector leg. */
  embedder?: EmbeddingProvider;
  confidence?: number;
}

export interface CaptureGitHistoryResult {
  /** Explanatory commits found in the scanned window. */
  mined: number;
  /** Pre-existing memories whose embedding an earlier run failed to write, now filled in. */
  embeddingsBackfilled: number;
  /** Newly written memories. 0 on a re-run over unchanged history. */
  recorded: number;
  /** Explanatory commits skipped because a memory for them already exists. */
  alreadyRecorded: number;
  /** Explanatory commits skipped because nothing in scope could be anchored. */
  unanchored: number;
  experiences: Experience[];
}

/**
 * Mines `repoDir`'s history and records each self-explaining commit as an
 * `Experience`, skipping any commit already recorded.
 *
 * Anchors are the commit's own repo-relative paths as plain text (spec.md
 * §24.2.2 / §24.4) — so a memory is retrievable and inspectable with no
 * structural node in existence.
 *
 * Since M12 they are written to the typed `anchors` column (migration 0006) AND
 * mirrored into `relatedNodes` as text. Until M15 that mirror also carried
 * structural node ids, supplied by a `resolveNodeIds` bridge into
 * `packages/structural`; both the bridge and the graph behind it are gone, so
 * the two columns now hold the same paths in two shapes. The mirror is kept
 * rather than dropped because it is where every memory written before M12
 * stored its anchors, `graph-store`'s anchor-match query reads both columns to
 * stay correct over that history, and renderers read it — the duplication is
 * legacy compatibility, not a live second binding.
 */
export async function captureGitHistory(
  options: CaptureGitHistoryOptions
): Promise<CaptureGitHistoryResult> {
  const commits = await mineCommits(options.repoDir, options.pathScope, options.limit);

  // Before recording anything new, finish what an earlier run may have left
  // half-done. The memory row and its embedding are necessarily two statements
  // (the embedding comes from an injected provider), and idempotency is keyed
  // on the memory — so without this, one failed embed() would hide that memory
  // from the vector leg permanently.
  const embeddingsBackfilled = options.embedder
    ? await backfillEmbeddings(options.embedder)
    : 0;

  // One query for the whole run, not one per commit: the idempotency check is
  // on the hot path of every sync, and an append-only table only grows.
  const alreadyRecordedActions = new Set(await listExperienceActions(COMMIT_ACTION_PREFIX));

  const experiences: Experience[] = [];
  let alreadyRecorded = 0;
  let unanchored = 0;

  // Oldest first, so the append-only log reads in the order things happened.
  for (const commit of [...commits].reverse()) {
    const action = commitAction(commit.shortSha);
    if (alreadyRecordedActions.has(action)) {
      alreadyRecorded += 1;
      continue;
    }

    const anchors = commit.files;
    if (anchors.length === 0) {
      unanchored += 1;
      continue;
    }

    const lesson = lessonFrom(commit);
    const saved = await recordExperience({
      task: commit.subject,
      observation: lesson,
      action,
      lessons: [lesson],
      relatedNodes: anchors,
      // Typed text anchors (spec.md §24.2.2 / M12), path-only: a commit's
      // name-status tells us which FILES it touched, not which symbols, and
      // inferring the symbol would need the parser §24.2 point 7 keeps off this
      // path. `symbol` is for capture sources that genuinely know one — a scout
      // report written by an agent that read the code.
      anchors: commit.files.map((path): Anchor => ({ path })),
      confidence: options.confidence ?? DEFAULT_CONFIDENCE,
      timestamp: commit.date || undefined,
    });
    if (options.embedder) {
      await upsertExperienceEmbedding(saved.id, await options.embedder.embed(embeddedText(saved)));
    }
    experiences.push(saved);
    // Guard against the same short sha appearing twice in one window (a
    // commit touching both of two mined path scopes), which would otherwise
    // slip past the pre-loaded set and write a duplicate within a single run.
    alreadyRecordedActions.add(action);
  }

  return {
    mined: commits.length,
    embeddingsBackfilled,
    recorded: experiences.length,
    alreadyRecorded,
    unanchored,
    experiences,
  };
}

/** Fills in embeddings for memories that have none. Exported for callers that only want the repair. */
export async function backfillEmbeddings(
  embedder: EmbeddingProvider,
  limit = 1000
): Promise<number> {
  const ids = await listExperienceIdsMissingEmbedding(limit);
  let filled = 0;
  for (const id of ids) {
    const experience = await getExperienceById(id);
    if (!experience) continue;
    await upsertExperienceEmbedding(id, await embedder.embed(embeddedText(experience)));
    filled += 1;
  }
  return filled;
}

/**
 * What gets embedded for a memory: the same `task || ' ' || observation` text
 * migration 0004's lexical indexes are built over, so all three legs of
 * by-meaning retrieval search the same content.
 */
export function embeddedText(experience: Experience): string {
  return `${experience.task} ${experience.observation}`;
}
