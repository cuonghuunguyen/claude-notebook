/**
 * By-meaning retrieval over knowledge (spec.md §24.2.1 / ROADMAP.md M11).
 *
 * This is the measured inversion of what the system shipped before. The old
 * path — `queryByNode`, and `runPipeline`'s node hydration on top of it —
 * could only reach a memory through a structural node hit: you had to already
 * know *where* before you could learn *why*. `WHY_MEMORY_SPIKE.md` scored that
 * path at MRR 0.13 against 0.75 for matching the question against the
 * experience's own text. Nothing here consults a node, a node id, or the
 * traversal at all; anchors are reported for the caller's benefit, never
 * consulted as a gate.
 *
 * Shape reuse (spec.md §24.4: "§9's hybrid-search shape is reused, pointed at
 * experience content"): independent legs run concurrently, then merge and
 * de-dupe into one ranked list — same as `packages/retrieval`'s
 * `retrieveSeeds`. Two differences, both forced by the data:
 *
 *  1. There are three legs, not two. §9's argument for trigram-over-tsvector
 *     was about *code identifiers*; an experience body is prose, where
 *     full-text ranking is the strong leg (and is the leg the 0.75 came from).
 *     Trigram is kept because it matches on characters rather than lexemes, so
 *     it can still reach a body that shares an unstemmed spelling with the
 *     question where the english stemmer has mangled both sides differently.
 *  2. The legs are merged by weighted Reciprocal Rank Fusion, not by
 *     `Math.max` of their scores the way `mergeHits` does. `mergeHits` can
 *     take a max because both of its legs produce 0–1 similarities; here
 *     `ts_rank` (typically 0.01–0.1), `word_similarity` (0–1) and cosine
 *     (0–1) are not on a comparable scale, so a max would let the two 0–1
 *     legs outrank the full-text leg unconditionally, whatever the ranking
 *     said. RRF only reads each leg's *rank order*, which is the part each leg
 *     is actually authoritative about.
 */
import type { Experience } from "@cognitive-memory/core";
import {
  searchExperiencesByEmbedding,
  searchExperiencesByFullText,
  searchExperiencesByTrigram,
  type ExperienceSearchHit,
} from "@cognitive-memory/graph-store";
import type { EmbeddingProvider } from "@cognitive-memory/retrieval";

/** Which search leg produced a hit. */
export type MeaningLeg = "text" | "trigram" | "vector";

export type MeaningReason =
  | "text_match"
  | "lexical_match"
  | "semantic_match"
  | "hybrid_match";

export interface ScoredExperience {
  experience: Experience;
  /** Fused rank score. Comparable within one `queryByMeaning` call only. */
  score: number;
  /** Every leg that returned this experience, in leg order. */
  legs: MeaningLeg[];
  /** §9-style reason tag; `hybrid_match` when more than one leg agreed. */
  reason: MeaningReason;
  /**
   * True when the memory carries at least one anchor of any kind — a text path
   * (spec.md §24.2.2) or a structural node id. Reported, never required: an
   * anchorless memory ranks exactly the same, and ranking never reads this.
   *
   * Deliberately NOT "a structural node exists for this memory". Checking that
   * would mean a node lookup per hit, and it is not a question retrieval needs
   * answered — capture anchors every memory to the paths it came from, so in
   * practice this is true for everything mined or scouted. Treat it as "is
   * there something to check this memory against later" (which is what M12's
   * staleness pass will need), not as evidence the graph knows about it.
   */
  anchored: boolean;
}

/**
 * Per-leg RRF weights. Not a knob for its own sake — they encode what has
 * actually been measured:
 *  - `text` is the leg `WHY_MEMORY_SPIKE.md` measured at MRR 0.75, so it is
 *    the reference weight;
 *  - `vector` is halved because the only embedder in the workspace today is
 *    `createFakeEmbedder`, a feature-hashing stub with no measured retrieval
 *    quality (spec.md §9 leaves the real provider to the application layer).
 *    Raise it to 1 once a real embedder has a number behind it.
 *  - `trigram` is halved for the same reason in reverse: it is a deliberate
 *    complement for identifier fragments, not a general prose ranker.
 */
export const DEFAULT_LEG_WEIGHTS: Readonly<Record<MeaningLeg, number>> = {
  text: 1,
  trigram: 0.5,
  vector: 0.5,
};

/** RRF's rank-smoothing constant. 60 is the value the original RRF paper used and the de-facto default. */
const DEFAULT_RRF_K = 60;
const DEFAULT_LIMIT = 5;
const DEFAULT_LEG_LIMIT = 20;
const DEFAULT_TRIGRAM_THRESHOLD = 0.35;

export interface QueryByMeaningOptions {
  /** Hits returned after fusion. Default 5. */
  limit?: number;
  /** Hits pulled from each leg before fusion. Default 20. */
  legLimit?: number;
  /** Vector leg. Omitted ⇒ lexical-only, exactly as `retrieveSeeds` treats a missing embedder. */
  embedder?: EmbeddingProvider;
  /** Pre-computed question embedding, to avoid a second `embed()` call (spec.md §22 step 1). */
  queryEmbedding?: number[];
  /** spec.md §18: include experiences already promoted to cold storage. Default false. */
  includeCold?: boolean;
  /** `word_similarity` floor for the trigram leg. Default 0.35. */
  trigramThreshold?: number;
  legWeights?: Partial<Record<MeaningLeg, number>>;
  rrfK?: number;
}

/** Stopwords dropped before building the tsquery. Question words in particular: every "why does X" question contains them, so they carry no discriminating signal. */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is",
  "are", "was", "were", "be", "been", "it", "its", "that", "this", "why",
  "what", "how", "does", "do", "did", "when", "which", "who", "whom", "there",
  "then", "than", "so", "as", "at", "by", "from", "into", "instead", "rather",
  "not", "no", "any", "ever", "still", "just", "also", "would", "could",
  "should", "can", "will", "happened", "happens", "used", "use", "we", "our",
  "i", "you",
]);

/**
 * Question -> OR-joined `tsquery` string.
 *
 * OR, not AND: a "why" question and the commit body that answers it overlap
 * on only a couple of content words, so ANDing them (what `plainto_tsquery`
 * and `websearch_to_tsquery` both do) returns nothing. `ts_rank` then does the
 * discriminating — a document matching four of the question's terms outranks
 * one matching a single term.
 *
 * camelCase/dotted identifiers are split so `$ZodCatch` or `regexes.ts`
 * contribute their parts, and every term is reduced to `[a-z0-9_]` so no
 * caller input can reach `to_tsquery` as syntax. Exported because the
 * spike/eval harnesses need to reproduce the exact query the shipped path
 * builds.
 */
export function toExperienceTsQuery(question: string): string {
  const terms = new Set(
    question
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[^a-zA-Z0-9_]+/)
      .map((t) => t.toLowerCase().replace(/[^a-z0-9_]/g, ""))
      .filter((t) => t.length > 2 && !STOPWORDS.has(t))
  );
  return [...terms].join(" | ");
}

const REASON_FOR_SINGLE_LEG: Record<MeaningLeg, MeaningReason> = {
  text: "text_match",
  trigram: "lexical_match",
  vector: "semantic_match",
};

/**
 * Weighted Reciprocal Rank Fusion over the legs, in leg order.
 *
 * Pure and exported so it can be unit-tested without a database — the fusion
 * rule is the part of by-meaning retrieval most likely to be got wrong, and
 * the part a Postgres integration test would only exercise incidentally.
 */
export function fuseLegs(
  legs: ReadonlyArray<{ leg: MeaningLeg; hits: ExperienceSearchHit[] }>,
  options: { limit?: number; legWeights?: Partial<Record<MeaningLeg, number>>; rrfK?: number } = {}
): ScoredExperience[] {
  const k = options.rrfK ?? DEFAULT_RRF_K;
  const weights = { ...DEFAULT_LEG_WEIGHTS, ...options.legWeights };

  const accumulated = new Map<
    string,
    { experience: Experience; score: number; legs: MeaningLeg[] }
  >();

  for (const { leg, hits } of legs) {
    const weight = weights[leg] ?? 0;
    hits.forEach((hit, index) => {
      const existing = accumulated.get(hit.experience.id);
      const contribution = weight / (k + index + 1);
      if (existing) {
        existing.score += contribution;
        if (!existing.legs.includes(leg)) existing.legs.push(leg);
      } else {
        accumulated.set(hit.experience.id, {
          experience: hit.experience,
          score: contribution,
          legs: [leg],
        });
      }
    });
  }

  return [...accumulated.values()]
    .map((entry) => ({
      experience: entry.experience,
      score: entry.score,
      legs: entry.legs,
      reason:
        entry.legs.length > 1
          ? ("hybrid_match" as const)
          : REASON_FOR_SINGLE_LEG[entry.legs[0] as MeaningLeg],
      anchored: entry.experience.relatedNodes.length > 0,
    }))
    // Ties are real (two experiences can hit the same rank in disjoint legs),
    // so break them deterministically instead of leaving Map order to decide:
    // newer knowledge first, then id.
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.experience.timestamp.localeCompare(a.experience.timestamp) ||
        a.experience.id.localeCompare(b.experience.id)
    )
    .slice(0, options.limit ?? DEFAULT_LIMIT);
}

/**
 * question -> the knowledge that answers it, ranked, with no structural node
 * involved. The M11 entry point.
 */
export async function queryByMeaning(
  question: string,
  options: QueryByMeaningOptions = {}
): Promise<ScoredExperience[]> {
  const legLimit = options.legLimit ?? DEFAULT_LEG_LIMIT;
  const searchOptions = { includeCold: options.includeCold ?? false };
  const tsQuery = toExperienceTsQuery(question);

  // Independent I/O, same as §9's two legs — never serialize the vector leg's
  // embed()-then-search behind the lexical queries.
  const [text, trigram, vector] = await Promise.all([
    searchExperiencesByFullText(tsQuery, legLimit, searchOptions),
    searchExperiencesByTrigram(
      question,
      legLimit,
      options.trigramThreshold ?? DEFAULT_TRIGRAM_THRESHOLD,
      searchOptions
    ),
    resolveQueryEmbedding(question, options).then((embedding) =>
      embedding ? searchExperiencesByEmbedding(embedding, legLimit, searchOptions) : []
    ),
  ]);

  return fuseLegs(
    [
      { leg: "text", hits: text },
      { leg: "trigram", hits: trigram },
      { leg: "vector", hits: vector },
    ],
    { limit: options.limit ?? DEFAULT_LIMIT, legWeights: options.legWeights, rrfK: options.rrfK }
  );
}

async function resolveQueryEmbedding(
  question: string,
  options: QueryByMeaningOptions
): Promise<number[] | undefined> {
  if (options.queryEmbedding) return options.queryEmbedding;
  if (!options.embedder) return undefined;
  return options.embedder.embed(question);
}
