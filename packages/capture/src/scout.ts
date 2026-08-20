/**
 * Agent-session distillation: the second of spec.md §24.2.1's two capture
 * source classes.
 *
 * An agent handed a task it has never seen spends its first turns scouting —
 * working out which subsystems are involved, how a flow actually runs, which
 * gotchas bite. That synthesized understanding is thrown away at task end, and
 * the next session pays for it again. `recordScoutReport` persists it.
 *
 * The guardrail is the interesting part, and it is a measurement, not a
 * preference. `E2E_BENCHMARK_MULTI_REPO.md` showed the structural graph losing
 * to grep at *code location* in every regime: "X lives in file Y" is a
 * question grep answers in one turn, so persisting it buys no turns and adds
 * staleness risk (spec.md §24.2.1 states this as a hard guardrail: "store
 * synthesized understanding, not bare locations"). So a report that is really
 * just a file listing is rejected at the API boundary rather than quietly
 * written and later blamed for polluting retrieval.
 */
import type { Experience } from "@cognitive-memory/core";
import { recordExperience } from "@cognitive-memory/episodic";
import { upsertExperienceEmbedding } from "@cognitive-memory/graph-store";
import type { EmbeddingProvider } from "@cognitive-memory/retrieval";
import { embeddedText } from "./git.js";

/** `Experience.action` prefix that identifies a distilled scout report. */
export const SCOUT_ACTION_PREFIX = "scout-report";

export const scoutAction = (source?: string): string =>
  source ? `${SCOUT_ACTION_PREFIX} ${source}` : SCOUT_ACTION_PREFIX;

/**
 * spec.md §4's evidence hierarchy places `agent_experience` above bare
 * `llm_inference` but below anything code- or history-derived. A distilled
 * scout report is exactly that: an agent's own synthesis, grounded in files it
 * really read, and the fastest-rotting class of memory there is (§24.2.1) —
 * hence a confidence below the 0.7 a git commit body gets, since a commit
 * message is a human explaining a decision at the moment of making it.
 */
const DEFAULT_CONFIDENCE = 0.55;

/** Below this, there is no "synthesized understanding" to speak of. */
export const MIN_UNDERSTANDING_CHARS = 200;
/** Prose words that survive stripping paths/identifiers. 25 ≈ two real sentences. */
export const MIN_PROSE_WORDS = 25;

export interface ScoutReportInput {
  /**
   * What was being scouted, phrased the way it would be asked again — this is
   * half the text by-meaning retrieval matches against, so
   * "how the retrieval pipeline composes its two legs" retrieves far better
   * than "scouting".
   */
  task: string;
  /**
   * The distilled understanding itself: subsystem map, how-X-works
   * walkthrough, gotchas. Prose, not a file listing (see the guardrail).
   */
  understanding: string;
  /**
   * Plain-text repo-relative paths the understanding covers (spec.md
   * §24.2.2). No structural node needs to exist for any of them.
   */
  anchors: string[];
  /** Short takeaways. Defaults to `[understanding]`, matching the git miner. */
  lessons?: string[];
  /** How the task the report came out of ended, if it ended. */
  result?: string;
  /** Session/agent identifier, recorded into `action` for provenance. */
  source?: string;
  confidence?: number;
  /** When given, the memory gets an embedding for by-meaning's vector leg. */
  embedder?: EmbeddingProvider;
}

export class BareLocationsError extends Error {
  constructor(message: string) {
    super(
      `${message} spec.md §24.2.1: a scout report must store synthesized ` +
        `understanding, not bare file locations — grep answers "where is X" in ` +
        `one turn (E2E_BENCHMARK_MULTI_REPO.md), so a location-only memory buys ` +
        `no turns and only adds staleness risk.`
    );
    this.name = "BareLocationsError";
  }
}

/** Paths, dotted filenames, bare identifiers with separators, and list bullets — the parts of a report that are *pointing* rather than *explaining*. */
const LOCATION_LIKE = /(^|\s)[-*•\d.)]+\s|[\w@./-]*\/[\w@./-]+|[\w-]+\.[a-z]{1,5}\b|[A-Za-z_$][\w$]*(?:[.#][\w$]+)+/g;

/**
 * The guardrail, exported so callers can pre-check (and so it is unit-testable
 * without a database).
 *
 * Two conditions, both needed. The length floor alone would pass a long list
 * of paths; the prose-word floor alone would pass two sentences of nothing.
 * What is measured is the text *after* removing everything that merely points
 * at code — if almost nothing is left, the report is a location list wearing
 * prose punctuation.
 */
export function proseWordCount(understanding: string): number {
  return understanding
    .replace(LOCATION_LIKE, " ")
    .split(/[^A-Za-z']+/)
    .filter((w) => w.length > 1).length;
}

export function assertSynthesizedUnderstanding(understanding: string): void {
  const trimmed = understanding.trim();
  if (trimmed.length < MIN_UNDERSTANDING_CHARS) {
    throw new BareLocationsError(
      `Scout report understanding is ${trimmed.length} chars, below the ${MIN_UNDERSTANDING_CHARS}-char floor.`
    );
  }
  const words = proseWordCount(trimmed);
  if (words < MIN_PROSE_WORDS) {
    throw new BareLocationsError(
      `Scout report has only ${words} words of prose once file paths and ` +
        `symbol references are removed (floor is ${MIN_PROSE_WORDS}).`
    );
  }
}

/**
 * Persists one distilled scout report as an `Experience`, anchored to plain
 * text paths. Retrievable immediately by `queryByMeaning` — no structural
 * node, no traversal, no ingest pass required.
 */
export async function recordScoutReport(input: ScoutReportInput): Promise<Experience> {
  assertSynthesizedUnderstanding(input.understanding);
  if (input.anchors.length === 0) {
    throw new Error(
      "Scout report needs at least one anchor path — an unanchored memory can " +
        "never be checked against the code it describes (spec.md §24.2.3)."
    );
  }

  const saved = await recordExperience({
    task: input.task,
    observation: input.understanding.trim(),
    action: scoutAction(input.source),
    result: input.result,
    lessons: input.lessons ?? [input.understanding.trim()],
    // Plain text anchors, deliberately: spec.md §24.4 — new knowledge binds to
    // text anchors, not node ids. Nothing dereferences these as node ids.
    relatedNodes: [...new Set(input.anchors)],
    confidence: input.confidence ?? DEFAULT_CONFIDENCE,
  });

  if (input.embedder) {
    await upsertExperienceEmbedding(saved.id, await input.embedder.embed(embeddedText(saved)));
  }
  return saved;
}
