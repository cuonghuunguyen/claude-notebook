import type { Anchor, Experience, MemoryTier } from "@cognitive-memory/core";
import { anchorsFromRelatedNodes } from "@cognitive-memory/core";
import { getDb, withTransaction, type Queryable, type TransactionClient } from "./db.js";
import { requireIsoUtc, toIsoUtc } from "./time.js";
import { wordSimilarity } from "./trigram.js";
import { cosineSimilarity, decodeEmbedding, encodeEmbedding } from "./vector.js";

/**
 * A row exactly as SQLite returns it (spec.md §25.5's type mapping): JSON
 * columns are TEXT, booleans are 0/1, timestamps are ISO-8601 UTC strings.
 *
 * Written out as the storage shape rather than the domain shape on purpose. The
 * Postgres driver parsed `jsonb` into arrays and `timestamptz` into `Date`
 * before any of this code saw it, so the decoding was invisible and impossible
 * to get wrong; here it is explicit, in one place (`rowToExperience`), which is
 * the only way a missed conversion shows up as a type error rather than as
 * `"[]"` where an array was expected.
 */
interface ExperienceRow {
  id: string;
  task: string;
  observation: string;
  /** spec.md §26. NULL until a distillation pass writes one; derived, never a rewrite of `observation`. */
  digest: string | null;
  hypothesis: string | null;
  action: string | null;
  result: string | null;
  lessons: string;
  related_nodes: string;
  anchors: string;
  suspect: number;
  suspect_reason: string | null;
  superseded_by: string | null;
  superseded_at: string | null;
  verified_at: string | null;
  confidence: number;
  timestamp: string;
  cold: number;
  /** spec.md §24.5. Read out onto search hits, never onto `Experience` — tier is storage/ranking metadata, not part of §8's contract. */
  tier: MemoryTier;
}

interface ScoredExperienceRow extends ExperienceRow {
  score: number;
}

function parseJsonArray<T>(text: string): T[] {
  const parsed = JSON.parse(text) as unknown;
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

function rowToExperience(row: ExperienceRow): Experience {
  const relatedNodes = parseJsonArray<string>(row.related_nodes);
  const anchors = parseJsonArray<Anchor>(row.anchors);
  return {
    id: row.id,
    task: row.task,
    observation: row.observation,
    digest: row.digest ?? undefined,
    hypothesis: row.hypothesis ?? undefined,
    action: row.action ?? undefined,
    result: row.result ?? undefined,
    lessons: parseJsonArray<string>(row.lessons),
    relatedNodes,
    // A memory written before migration 0006 has an empty `anchors` column but
    // may well carry paths in `related_nodes` (M11's capture put them there).
    // Falling back keeps every pre-M12 memory checkable by the §24.2.3
    // staleness pass instead of silently exempting it — and it is a read-time
    // derivation, so nothing is rewritten and the fallback stays reversible.
    anchors: anchors.length > 0 ? anchors : anchorsFromRelatedNodes(relatedNodes),
    suspect: row.suspect === 1,
    suspectReason: row.suspect_reason ?? undefined,
    supersededBy: row.superseded_by ?? undefined,
    supersededAt: row.superseded_at ?? undefined,
    verifiedAt: row.verified_at ?? undefined,
    confidence: row.confidence,
    timestamp: row.timestamp,
  };
}

const EXPERIENCE_COLUMNS = `id, task, observation, digest, hypothesis, action, result, lessons, related_nodes, anchors, suspect, suspect_reason, superseded_by, superseded_at, verified_at, confidence, "timestamp", cold, tier`;

/**
 * The same column list qualified with the `e` alias, for the queries that join
 * `experiences` against something else carrying an `id` column (the recursive
 * chain walks, and the FTS5 leg). Derived rather than written out twice so a
 * future column cannot be added to one and not the other.
 */
const EXPERIENCE_COLUMNS_QUALIFIED = EXPERIENCE_COLUMNS.split(", ")
  .map((column) => `e.${column}`)
  .join(", ");

/** A JSON array parameter, for the `json_each` sites spec.md §25.5's table names. */
function jsonArray(values: readonly unknown[]): string {
  return JSON.stringify(values);
}

/**
 * Append-only per spec.md §8 — there is deliberately no update/delete
 * export in this module. If you need to "correct" an experience, record a
 * new one; read-repair's supersede chain (M13) is the supported path.
 */
export interface RecordExperienceOptions {
  /**
   * The session recording this memory, when there is one (spec.md §24.5).
   * Stored so that session's own later retrievals of it settle as `self` and
   * cannot promote it — the no-self-promotion rule. A mined commit has no
   * session and leaves this null, which correctly makes every session
   * distinct from its (nonexistent) writer.
   */
  writerSession?: string;
}

export async function recordExperience(
  experience: Experience,
  db: Queryable = getDb(),
  options: RecordExperienceOptions = {}
): Promise<Experience> {
  const { rows } = await db.query<ExperienceRow>(
    `
    INSERT INTO experiences (id, task, observation, hypothesis, action, result, lessons, related_nodes, anchors, confidence, "timestamp", writer_session)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), $12)
    RETURNING ${EXPERIENCE_COLUMNS}
    `,
    [
      experience.id,
      experience.task,
      experience.observation,
      experience.hypothesis ?? null,
      experience.action ?? null,
      experience.result ?? null,
      JSON.stringify(experience.lessons ?? []),
      JSON.stringify(experience.relatedNodes),
      // Text anchors (spec.md §24.2.2). `suspect` is deliberately not insertable
      // — a memory is born trusted, and only the staleness pass may flag it.
      JSON.stringify(experience.anchors ?? []),
      experience.confidence,
      // Load-bearing for spec.md §24 capture: a memory mined from git history
      // must carry the *commit's* date, or §24.2.3's "is the last commit
      // touching my anchors newer than this memory?" staleness test is
      // meaningless — every mined memory would look newer than the history it
      // was mined from.
      //
      // Normalized to UTC here rather than stored as given: capture supplies
      // git's `%aI`, which is offset form, and a TEXT column holding a mix of
      // `+02:00` and `Z` sorts wrong (see `time.ts`). Postgres's `timestamptz`
      // did this normalization itself, so this preserves the old behaviour
      // rather than adding a new one.
      toIsoUtc(experience.timestamp ?? null),
      options.writerSession ?? null,
    ]
  );
  const row = rows[0];
  if (!row) throw new Error(`recordExperience: no row returned for ${experience.id}`);
  return rowToExperience(row);
}

export interface ExperienceQueryOptions {
  /** spec.md §18: cold experiences are excluded from default retrieval. Set true to include them (e.g. an explicit "search full history" request). */
  includeCold?: boolean;
  /**
   * spec.md §24.2 decision 4 / §24.6: a memory that read-repair has replaced
   * with a correction is excluded from default retrieval — the chain's head
   * answers. Set true for an explicit "what did we believe before" query.
   *
   * Applied to EVERY experience query in this module, not just the by-meaning
   * legs M13's acceptance names. A retracted memory that stays reachable
   * through by-task is retracted in name only, and that is a path
   * `runPipeline` and the promotion pipeline read.
   */
  includeSuperseded?: boolean;
}

/**
 * The default-retrieval predicate shared by every query below, as SQL text.
 *
 * Written once because it is a policy, not a detail: "cold and superseded rows
 * are out unless explicitly asked for" has to hold identically across every
 * query, and the previous copy-paste of the cold half is exactly how the
 * superseded half would come to be missing from one of them.
 *
 * `coldParam`/`supersededParam` are 1-based placeholder numbers supplied by the
 * caller — the callers' other parameters are already numbered, so this cannot
 * own the numbering. `alias` qualifies the columns for the queries that join.
 *
 * The flags bind as SQLite integers (0/1) and `NOT cold` reads a 0/1 column, so
 * the predicate is the same text it was under Postgres booleans.
 */
function defaultVisibility(coldParam: number, supersededParam: number, alias = ""): string {
  const prefix = alias ? `${alias}.` : "";
  return `($${coldParam} OR NOT ${prefix}cold) AND ($${supersededParam} OR ${prefix}superseded_by IS NULL)`;
}

export async function queryExperiencesByTask(
  task: string,
  options: ExperienceQueryOptions = {}
): Promise<Experience[]> {
  const { rows } = await getDb().query<ExperienceRow>(
    `SELECT ${EXPERIENCE_COLUMNS} FROM experiences
     WHERE task = $1 AND ${defaultVisibility(2, 3)}
     ORDER BY "timestamp" DESC`,
    [task, options.includeCold ?? false, options.includeSuperseded ?? false]
  );
  return rows.map(rowToExperience);
}

/**
 * spec.md §18: retire an experience to cold storage — still queryable via
 * `includeCold`, just out of the default hot path. Pure status flip, no event:
 * cold/hot is not part of the spec.md §14 event vocabulary, and nothing about
 * the experience's own content changed.
 *
 * Its automatic caller retired with the structural graph at M15: §18's
 * cold-eligibility rule was "every structural node this memory is bound to
 * already has a durable semantic edge", and neither a structural node nor a
 * semantic edge can exist any more. The setter stays because `cold` is still a
 * real, read stored state — existing rows carry it and every by-meaning leg
 * filters on it — and because §18 needs an actuator for whatever retention
 * rule replaces the edge-based one. Today nothing calls it automatically:
 * `packages/gc` reports idle short-term memories (§24.5) and deliberately does
 * not act on them, see `gc/src/idleTier.ts` for why.
 */
export async function markExperienceCold(id: string): Promise<void> {
  await getDb().query(`UPDATE experiences SET cold = 1 WHERE id = $1`, [id]);
}

// ---------------------------------------------------------------------------
// Content search over knowledge (spec.md §24.2.1 / ROADMAP.md M11), on SQLite
// (spec.md §25.3).
//
// The three functions below are the storage primitives for by-meaning
// retrieval: they find an experience by what it *says*, with no reference to
// any structural node — and since M15 there is no structural node to refer to.
// `packages/episodic`'s `queryByMeaning` composes them into one hybrid query.
//
// Two of the three are now full scans scored in JS rather than SQL predicates.
// That is spec.md §25.1's own argument, applied where it was measured: the
// corpus is hundreds-to-thousands of memories, cosine over 300x that is 19 ms,
// and neither an HNSW index nor a GIN trigram index was buying anything at this
// size. §25.7 names the corpus size at which that stops being true. Only the
// full-text leg — the strongest one — keeps a real index, FTS5.
//
// Every one of them honours §18's cold flag the same way `queryExperiencesByTask`
// does. Note what `cold` now means: nothing marks a memory cold automatically
// any more (the edge-based rule went with the edges, see `packages/gc`), so in
// practice the flag is only set by an explicit `markExperienceCold` call.
// ---------------------------------------------------------------------------

/**
 * The searched text: exactly what the FTS5 index and the trigram scan are built
 * over. `coalesce` per spec.md §26 — a distilled memory is searched by its
 * digest, an undistilled one by its raw body, and migration 0003 keeps the FTS5
 * generated column and its triggers on this same expression.
 */
const EXPERIENCE_TEXT = `(task || ' ' || coalesce(digest, observation))`;

export interface ExperienceSearchHit {
  experience: Experience;
  /** Leg-native score. NOT comparable across legs — see episodic's merge. */
  score: number;
  /**
   * spec.md §24.5 tier, carried on the hit rather than on the `Experience`.
   * Ranking needs it (it is a §11 score multiplier) and it is already in the
   * row, so plumbing it here costs nothing; putting it on `Experience` would
   * mean changing a spec.md §8 type to carry a retrieval-time concern.
   *
   * Every leg returns it, so tier can never become a *filter* by accident:
   * the searches themselves span all tiers exactly as before.
   */
  tier: MemoryTier;
}

function rowToHit(row: ScoredExperienceRow): ExperienceSearchHit {
  return { experience: rowToExperience(row), score: row.score, tier: row.tier };
}

/**
 * `a | b` (the `tsquery` form `packages/episodic` builds) to an FTS5 MATCH
 * expression.
 *
 * `toExperienceTsQuery`'s output format is deliberately NOT changed: it is
 * exported, the eval harnesses reproduce the exact query the shipped path
 * builds, and the OR-of-content-words shape is the caller policy that
 * WHY_MEMORY_SPIKE.md's 0.75 came from. What changes is only the dialect it is
 * spoken in, and that translation belongs to the storage leg.
 *
 * Every term is double-quoted so it is a literal string to FTS5 rather than
 * syntax. Episodic already reduces each term to `[a-z0-9_]`, and `_` is a token
 * separator for `unicode61`, which makes such a term a two-token phrase — quoting
 * is what keeps that a phrase instead of a syntax error.
 */
export function toFts5Match(orQuery: string): string {
  const terms = orQuery
    .split("|")
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
    .map((term) => `"${term.replace(/"/g, '""')}"`);
  return terms.join(" OR ");
}

/**
 * Full-text leg. FTS5 over `task || ' ' || observation`, ranked by `bm25()`.
 *
 * `tsQuery` is a ready-made OR-joined term list rather than a raw question,
 * because the useful query shape here is caller policy, not storage policy:
 * WHY_MEMORY_SPIKE.md's 0.75 came from OR-joining the question's content words
 * (a "why" question shares only a few terms with the commit body that answers
 * it), which neither `plainto_tsquery` nor `websearch_to_tsquery` produced —
 * both ANDed their terms, and FTS5's default is an AND too.
 * `packages/episodic` owns that construction; this function owns the ranking.
 *
 * `bm25()` returns a negative number where more-negative is better, so the score
 * is negated to keep the "higher is better" convention every leg reports in and
 * `fuseLegs` is unchanged (it reads rank order, never the scale — spec.md §25.3).
 *
 * Passing an empty string returns nothing rather than throwing, so a question
 * made entirely of stopwords degrades to "no lexical hits".
 */
export async function searchExperiencesByFullText(
  tsQuery: string,
  limit = 10,
  options: ExperienceQueryOptions = {}
): Promise<ExperienceSearchHit[]> {
  const match = toFts5Match(tsQuery);
  if (!match) return [];
  const { rows } = await getDb().query<ScoredExperienceRow>(
    `SELECT ${EXPERIENCE_COLUMNS_QUALIFIED}, -bm25(experiences_fts) AS score
       FROM experiences_fts
       JOIN experiences e ON e.rowid = experiences_fts.rowid
      WHERE experiences_fts MATCH $1
        AND ${defaultVisibility(3, 4, "e")}
      ORDER BY score DESC, e."timestamp" DESC, e.id
      LIMIT $2`,
    [match, limit, options.includeCold ?? false, options.includeSuperseded ?? false]
  );
  return rows.map(rowToHit);
}

/** One scan row for the two legs that score in JS. */
interface ScanRow {
  id: string;
  timestamp: string;
  search_text?: string;
  embedding?: Buffer | null;
}

/**
 * Orders JS-scored candidates the way the SQL legs did — `score DESC,
 * "timestamp" DESC, id` — and truncates.
 *
 * The tie-breakers are not decoration. Two memories can score identically (the
 * trigram leg's threshold makes exact ties common on short questions), and
 * `fuseLegs` reads *rank*, so a nondeterministic order inside a leg would make
 * the fused result nondeterministic — which would defeat the gate spec.md §25.5
 * sets on this port.
 */
function rankScanned(
  scored: ReadonlyArray<{ row: ScanRow; score: number }>,
  limit: number
): Array<{ id: string; score: number }> {
  return [...scored]
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.row.timestamp.localeCompare(a.row.timestamp) ||
        a.row.id.localeCompare(b.row.id)
    )
    .slice(0, limit)
    .map(({ row, score }) => ({ id: row.id, score }));
}

/** Hydrates full rows for already-ranked ids, preserving the ranking. */
async function hydrateRanked(
  ranked: ReadonlyArray<{ id: string; score: number }>
): Promise<ExperienceSearchHit[]> {
  if (ranked.length === 0) return [];
  const { rows } = await getDb().query<ExperienceRow>(
    `SELECT ${EXPERIENCE_COLUMNS} FROM experiences
      WHERE id IN (SELECT value FROM json_each($1))`,
    [jsonArray(ranked.map((entry) => entry.id))]
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ranked.flatMap((entry) => {
    const row = byId.get(entry.id);
    return row ? [rowToHit({ ...row, score: entry.score })] : [];
  });
}

/**
 * Trigram leg (spec.md §9's `pg_trgm` choice, pointed at experience text),
 * recomputed in JS (`trigram.ts`).
 *
 * `query` is the caller's whole question, deliberately. That means this leg is
 * a character-level whole-question matcher, not a per-identifier rescue: it will
 * find a body that shares an unstemmed spelling with the question (`regexes.ts`,
 * `$ZodCatch`, `__proto__`) because those trigrams push the score up, but it
 * does not isolate those fragments and score them on their own. Measured on a
 * real eval pair, whole-question word similarity against the answering body was
 * 0.49 against a 0.35 floor, while the isolated identifier scored 0.83 — so
 * isolating terms would be a genuinely stronger leg, and is left as a follow-up
 * rather than asserted here as already done.
 *
 * `threshold` is a plain argument now. Under Postgres it could only be a GUC
 * (`<%` reads `pg_trgm.word_similarity_threshold`), which forced this function
 * to open an explicit transaction just to `set_config(..., is_local => true)` so
 * the setting died with it instead of riding a pooled connection for the rest of
 * its life. spec.md §25.4 deletes that whole apparatus: there is no session
 * state to leak, so there is no transaction here either.
 *
 * The scan selects only id/timestamp/text — not the full row, and above all not
 * `embedding`, which is 6 KB per memory. Full rows are fetched for the survivors
 * only.
 */
export async function searchExperiencesByTrigram(
  query: string,
  limit = 10,
  threshold = 0.35,
  options: ExperienceQueryOptions = {}
): Promise<ExperienceSearchHit[]> {
  if (!query.trim()) return [];
  const { rows } = await getDb().query<ScanRow>(
    `SELECT id, "timestamp", ${EXPERIENCE_TEXT} AS search_text
       FROM experiences
      WHERE ${defaultVisibility(1, 2)}`,
    [options.includeCold ?? false, options.includeSuperseded ?? false]
  );
  const scored = rows
    // The threshold is passed down as a pruning floor, not just used to filter:
    // it is what bounds the extent search (see `wordSimilarity`), and without it
    // this leg measured 3.9 s per question against the full-text leg's 9 ms.
    // Scores below it are therefore approximate, which is sound because they are
    // exactly the ones being discarded on the next line.
    .map((row) => ({ row, score: wordSimilarity(query, row.search_text ?? "", threshold) }))
    .filter((entry) => entry.score >= threshold);
  return hydrateRanked(rankScanned(scored, limit));
}

/**
 * Vector leg. Cosine similarity (higher is better), the same convention the
 * pgvector leg exposed with `1 - (a <=> b)`.
 *
 * Brute force over every embedded memory, no index — spec.md §25.1 measured
 * that at 19 ms for 300x this corpus, which is why there is no vector extension
 * in the stack any more. §25.7 names the ceiling.
 */
export async function searchExperiencesByEmbedding(
  embedding: number[],
  limit = 10,
  options: ExperienceQueryOptions = {}
): Promise<ExperienceSearchHit[]> {
  const { rows } = await getDb().query<ScanRow>(
    `SELECT id, "timestamp", embedding
       FROM experiences
      WHERE embedding IS NOT NULL
        AND ${defaultVisibility(1, 2)}`,
    [options.includeCold ?? false, options.includeSuperseded ?? false]
  );
  const scored = rows.map((row) => ({
    row,
    score: row.embedding ? cosineSimilarity(embedding, decodeEmbedding(row.embedding)) : 0,
  }));
  return hydrateRanked(rankScanned(scored, limit));
}

/**
 * Writes the embedding the vector leg searches. Separate from
 * `recordExperience` deliberately (spec.md §9): computing it is the caller's
 * business via an injected provider, and a capture run without an embedder
 * must still be able to write the memory.
 *
 * This is the one write that touches an existing experience row, and it is
 * still consistent with spec.md §8's append-only rule: it adds a derived
 * search index for content that never changes, not a correction to what the
 * experience says. (Corrections are M13's `supersedes` chain.)
 */
export async function upsertExperienceEmbedding(id: string, embedding: number[]): Promise<void> {
  await getDb().query(`UPDATE experiences SET embedding = $2 WHERE id = $1`, [
    id,
    encodeEmbedding(embedding),
  ]);
}

/**
 * Ids of experiences that have no embedding yet, so a capture run with an
 * embedder can finish a job an earlier run left half-done.
 *
 * This is not hypothetical tidiness: the memory row and its embedding are two
 * statements (the embedding is computed by an injected provider, so it cannot
 * be part of the insert), and capture's idempotency key is the memory's
 * `action`. Without a backfill, any failure between the two — a provider
 * timeout, a crash — leaves a row that every later sync skips and that the
 * vector leg can therefore never see again.
 */
export async function listExperienceIdsMissingEmbedding(limit = 1000): Promise<string[]> {
  const { rows } = await getDb().query<{ id: string }>(
    `SELECT id FROM experiences WHERE embedding IS NULL ORDER BY "timestamp" LIMIT $1`,
    [limit]
  );
  return rows.map((row) => row.id);
}

/**
 * Writes a memory's distilled digest (spec.md §26) and drops its embedding, so
 * the existing `listExperienceIdsMissingEmbedding` backfill re-embeds it from
 * the digest on the same sync. Two derived columns, one of which invalidates
 * the other — expressed as a single statement rather than as a rule a caller
 * has to remember.
 *
 * Consistent with §8's append-only rule for the same reason
 * `upsertExperienceEmbedding` is: this adds derived search material for content
 * that never changes, it does not correct what the memory says.
 */
export async function setExperienceDigest(id: string, digest: string): Promise<void> {
  await getDb().query(`UPDATE experiences SET digest = $2, embedding = NULL WHERE id = $1`, [
    id,
    digest,
  ]);
}

/**
 * Memories with no digest yet, oldest first — the distillation worklist.
 *
 * Superseded rows are excluded: they are invisible to retrieval by default, so
 * distilling one spends an LLM call on text nothing will ever search.
 */
export async function listExperiencesMissingDigest(limit = 200): Promise<Experience[]> {
  const { rows } = await getDb().query<ExperienceRow>(
    `SELECT ${EXPERIENCE_COLUMNS} FROM experiences
      WHERE digest IS NULL AND superseded_by IS NULL
      ORDER BY "timestamp"
      LIMIT $1`,
    [limit]
  );
  return rows.map(rowToExperience);
}

/** Full text of one experience, for computing its embedding. */
export async function getExperienceById(id: string): Promise<Experience | undefined> {
  const { rows } = await getDb().query<ExperienceRow>(
    `SELECT ${EXPERIENCE_COLUMNS} FROM experiences WHERE id = $1`,
    [id]
  );
  const row = rows[0];
  return row ? rowToExperience(row) : undefined;
}

/**
 * Distinct `action` values starting with `prefix` — the idempotency check for
 * capture (spec.md §24.2.1: re-mining the same history writes nothing new).
 * Returns just the strings, deliberately: resolving "have I already recorded
 * commit abc12345?" must not hydrate a full experience row per candidate.
 */
export async function listExperienceActions(prefix = ""): Promise<string[]> {
  const { rows } = await getDb().query<{ action: string }>(
    `SELECT DISTINCT action FROM experiences WHERE action IS NOT NULL AND action LIKE $1 || '%'`,
    [prefix]
  );
  return rows.map((row) => row.action);
}

// ---------------------------------------------------------------------------
// Text anchors + commit-triggered staleness (spec.md §24.2.2-§24.2.3 /
// ROADMAP.md M12).
// ---------------------------------------------------------------------------

/**
 * Memories anchored to any of `paths` — the query the sync-time staleness pass
 * runs once per batch of changed paths.
 *
 * Postgres did this with jsonb containment (`anchors @> '[{"path": ...}]'`)
 * riding a GIN index. SQLite has neither, so spec.md §25.5's table replaces it
 * with `json_each` + `json_extract`: the anchors array is unnested per row and
 * each element's `path` compared against the changed-path set, also unnested
 * from a JSON parameter. `EXISTS` rather than a join, so a memory anchored to
 * three changed paths still comes back once.
 *
 * What was lost with the GIN index is the index, not the semantics — and the
 * semantics are the part that was load-bearing. Containment matched
 * `{"path": x, "symbol": y}` for a path-level trigger because it is per-object
 * subset matching; `json_extract(value, '$.path') = ?` matches the same rows for
 * the same reason, without needing the symbol to be absent. This is a full scan
 * now, accepted per the note at the end of `migrations/0001_baseline.sql`: it
 * runs once per sync, not once per retrieval.
 *
 * The second leg over `related_nodes` is the pre-M12 half, and it is not
 * optional: every memory M11's capture recorded has its paths ONLY in
 * `related_nodes`, so an `anchors`-only predicate would make the entire existing
 * corpus permanently invisible to the staleness pass — the flag would work only
 * for memories written after M12. `rowToExperience` already derives anchors from
 * `related_nodes` on read; this is the same fallback pushed down to the lookup so
 * those memories are candidates in the first place.
 *
 * One asymmetry to know about: `related_nodes` holds anchors in *text* form, so
 * this leg matches a bare path exactly and will not find a legacy
 * `path#symbol` entry from a path-level trigger. New writes populate `anchors`
 * where the object comparison handles that case properly; nothing is silently
 * wrong, the older form is just coarser.
 *
 * Superseded memories are EXCLUDED, unlike cold ones — the two flags look
 * similar and are not. A cold memory (§18) is still the current answer, merely
 * promoted out of the hot path, so a staleness verdict on it must keep being
 * maintained against the day `includeCold` brings it back. A superseded memory
 * has been *retracted*: something else is the answer now, and "has history
 * moved past this text" is a question about a claim nobody will act on. Keeping
 * them in would also permanently inflate `markSuspectFromHistory`'s `marked`
 * count — the very number the read-repair loop watches to see whether repairs
 * are landing — since a retired memory stays older than the commits that
 * flagged it forever.
 */
export async function listExperiencesByAnchorPaths(paths: readonly string[]): Promise<Experience[]> {
  const distinct = [...new Set(paths.filter((path) => path.trim().length > 0))];
  if (distinct.length === 0) return [];
  const { rows } = await getDb().query<ExperienceRow>(
    `SELECT ${EXPERIENCE_COLUMNS} FROM experiences
      WHERE (EXISTS (SELECT 1 FROM json_each(anchors) a
                      WHERE json_extract(a.value, '$.path')
                            IN (SELECT value FROM json_each($1)))
         OR EXISTS (SELECT 1 FROM json_each(related_nodes) r
                     WHERE r.value IN (SELECT value FROM json_each($1))))
        AND superseded_by IS NULL
      ORDER BY "timestamp" DESC, id`,
    [jsonArray(distinct)]
  );
  return rows.map(rowToExperience);
}

/**
 * Flags memories as suspect (spec.md §24.2.3).
 *
 * Not append-only-violating, on the same reasoning `upsertExperienceEmbedding`
 * documents: this writes a *derived verdict about* the memory, not a correction
 * to what the memory says. The memory's own text is untouched, and correcting
 * content remains M13's `supersedes` chain.
 *
 * One statement for the whole batch, so marking 300 memories after a big merge
 * is one round trip rather than 300. `unnest($1::text[], $2::text[])` became
 * `json_each` over a single JSON array of objects (spec.md §25.5) — one
 * parameter instead of two parallel arrays, which also removes the possibility
 * of the two arrays disagreeing in length. Idempotent: re-running the same sync
 * re-writes the same verdict.
 */
export async function markExperiencesSuspect(
  entries: ReadonlyArray<{ id: string; reason: string }>
): Promise<number> {
  if (entries.length === 0) return 0;
  const { rowCount } = await getDb().query(
    `UPDATE experiences
        SET suspect = 1,
            suspect_reason = (
              SELECT json_extract(v.value, '$.reason') FROM json_each($1) v
               WHERE json_extract(v.value, '$.id') = experiences.id)
      WHERE id IN (SELECT json_extract(v.value, '$.id') FROM json_each($1) v)`,
    [jsonArray(entries)]
  );
  return rowCount;
}

/**
 * Clears the suspect flag on one memory.
 *
 * M12 never calls this — nothing in that milestone can establish that a
 * suspect memory is actually still correct, and pretending otherwise is how a
 * staleness system starts lying. It exists because M13's read-repair is the
 * step that CAN establish it (verify against current code, then either clear or
 * supersede).
 */
export async function clearExperienceSuspect(id: string): Promise<void> {
  await getDb().query(
    `UPDATE experiences SET suspect = 0, suspect_reason = NULL WHERE id = $1`,
    [id]
  );
}

// ---------------------------------------------------------------------------
// Read-repair: verification stamps + supersede chains
// (spec.md §24.2 decision 4 / §24.6, ROADMAP.md M13).
// ---------------------------------------------------------------------------

/**
 * Read-repair's "still accurate" outcome: clear the doubt AND record when the
 * check happened (spec.md §24.6).
 *
 * `clearExperienceSuspect` above is not enough on its own, and the difference
 * is the entire reason this function exists. M12's staleness verdict is
 * *recomputed* at read time from git as well as persisted, so clearing the
 * persisted flag leaves the read-time test to re-derive the identical verdict
 * from the identical commit one query later — the repair would last exactly
 * until the next read. Stamping `verified_at` moves the instant that test
 * measures from (`stalenessAsOf`), which is what makes "I checked; it's fine"
 * survive.
 *
 * Not a suppression: only commits made BEFORE the verification stop counting.
 * The next commit to touch the anchored files flags the memory again, exactly
 * as §24.2.3 intends.
 *
 * `verifiedAt` is a parameter rather than `now()` so a caller can stamp the
 * instant it actually read the code at, not the instant its database write
 * landed — a refine run that reads a file, thinks, and writes minutes later
 * must not claim to have verified against commits that landed in between.
 *
 * Returns false when no such memory exists, so a caller repairing a stale id
 * finds out instead of believing it succeeded.
 */
export async function markExperienceVerified(
  id: string,
  verifiedAt: string = new Date().toISOString()
): Promise<boolean> {
  const { rowCount } = await getDb().query(
    `UPDATE experiences
        SET suspect = 0, suspect_reason = NULL, verified_at = $2
      WHERE id = $1`,
    [id, requireIsoUtc(verifiedAt)]
  );
  return rowCount > 0;
}

/**
 * Recursion guard for the chain walks. A cycle is refused at write time and
 * forbidden by a CHECK, so this bound is only ever reached by data written
 * around this module — in which case a bounded wrong answer beats a query that
 * never returns. Far above any chain a real repair history produces.
 */
const MAX_CHAIN_DEPTH = 1000;

/** Thrown by `supersedeExperience` when the link asked for is not representable. */
export class SupersedeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupersedeError";
  }
}

export interface SupersedeResult {
  /** False when the link already existed exactly as asked — the call was a no-op. */
  linked: boolean;
  supersededAt: string;
}

/**
 * Read-repair's "was wrong" outcome: link an outdated memory to the correction
 * that replaces it (spec.md §24.2 decision 4).
 *
 * The correction must already exist as its own memory. That ordering is
 * deliberate rather than an API inconvenience: the correction is a first-class
 * memory with its own anchors, confidence and `ExperienceRecorded` event, and
 * the link is a second fact about a *pair* of memories. Folding both into one
 * call would make the correction unrecordable without a victim, which is wrong
 * — plenty of new knowledge supersedes nothing.
 *
 * Three refusals, all of them shapes that would silently destroy knowledge
 * rather than merely fail:
 *
 *  - a memory superseding itself: the row would satisfy no default retrieval
 *    (`superseded_by IS NULL` fails) and have no successor to answer in its
 *    place. Also enforced by the baseline's CHECK.
 *  - a memory already superseded by something ELSE: overwriting the pointer
 *    orphans the previous correction — it stays a head, so BOTH corrections
 *    answer, which is the fork the single-column design exists to prevent.
 *    Re-linking to the same successor is idempotent instead of an error, so a
 *    retried refine run is safe.
 *  - a cycle: if the correction is (transitively) already superseded by the
 *    memory being retired, linking closes a loop in which every member fails
 *    `superseded_by IS NULL` and the whole chain vanishes from retrieval.
 *
 * ## How the check-then-write is serialized now
 *
 * Under Postgres this needed real work, and the analysis is worth keeping
 * because the hazard it describes is a property of the data model, not of the
 * engine. `FOR UPDATE` on the old row serialized two runs racing on the SAME
 * memory, but the cycle check reads *other* rows, and under READ COMMITTED it
 * could not see another transaction's uncommitted pointer: two runs doing
 * `supersede(X, Y)` and `supersede(Y, X)` concurrently locked different rows and
 * each walked a snapshot in which the other's link did not exist, so both cycle
 * checks passed. What actually prevented a committed cycle was the foreign key
 * taking an implicit `FOR KEY SHARE` lock, which deadlocked the pair — a fine
 * outcome to have and a bad one to rely on, since it surfaced as
 * `deadlock detected` rather than the specific refusal below. A
 * transaction-scoped advisory lock was added to make the refusal the observable
 * one.
 *
 * SQLite has one global write lock, so both halves of that are the engine's
 * default across processes, and `withTransaction` provides the in-process half
 * (see `db.ts`: two concurrent async transactions on one connection would
 * otherwise interleave). `BEGIN IMMEDIATE` takes the write lock before the check
 * reads anything, so the check and the write are atomic against every other
 * supersede, and the loser gets the real reason rather than a deadlock.
 * spec.md §25.4 therefore *deletes* both `pg_advisory_lock` uses and the
 * `FOR UPDATE` rather than porting them — there is nothing left for them to
 * simulate.
 */
export async function supersedeExperience(
  oldId: string,
  newId: string,
  options: { supersededAt?: string; db?: TransactionClient } = {}
): Promise<SupersedeResult> {
  if (oldId === newId) {
    throw new SupersedeError(`a memory cannot supersede itself (${oldId})`);
  }
  const supersededAt = options.supersededAt ?? new Date().toISOString();

  const run = async (db: Queryable): Promise<SupersedeResult> => {
    const { rows: oldRows } = await db.query<{ superseded_by: string | null }>(
      `SELECT superseded_by FROM experiences WHERE id = $1`,
      [oldId]
    );
    const existing = oldRows[0];
    if (!existing) throw new SupersedeError(`no such experience to supersede: ${oldId}`);

    const { rows: newRows } = await db.query<{ id: string }>(
      `SELECT id FROM experiences WHERE id = $1`,
      [newId]
    );
    if (!newRows[0]) throw new SupersedeError(`no such superseding experience: ${newId}`);

    if (existing.superseded_by === newId) return { linked: false, supersededAt };
    if (existing.superseded_by !== null) {
      throw new SupersedeError(
        `${oldId} is already superseded by ${existing.superseded_by}; ` +
          `supersede ${existing.superseded_by} instead (chains do not fork)`
      );
    }

    // Walk forward from the correction. If the memory being retired is
    // reachable, linking would close a cycle.
    const { rows: cycle } = await db.query<{ id: string }>(
      `WITH RECURSIVE forward(id, depth) AS (
           SELECT id, 0 FROM experiences WHERE id = $1
         UNION ALL
           SELECT e.superseded_by, f.depth + 1
             FROM experiences e JOIN forward f ON e.id = f.id
            WHERE e.superseded_by IS NOT NULL AND f.depth < ${MAX_CHAIN_DEPTH}
       )
       SELECT id FROM forward WHERE id = $2 LIMIT 1`,
      [newId, oldId]
    );
    if (cycle[0]) {
      throw new SupersedeError(
        `linking ${oldId} -> ${newId} would close a supersede cycle`
      );
    }

    // Clearing `suspect` is part of the milestone's own definition of the
    // repair ("write a corrected memory that supersedes the old one — and clear
    // the suspect mark", ROADMAP M13). It is not cosmetic: the doubt has been
    // *answered*, and leaving it standing keeps the retired memory in every
    // count of "memories still needing read-repair", so the number the
    // dogfooding loop watches would never come down as repairs land.
    await db.query(
      `UPDATE experiences
          SET superseded_by = $2, superseded_at = $3,
              suspect = 0, suspect_reason = NULL
        WHERE id = $1`,
      [oldId, newId, requireIsoUtc(supersededAt)]
    );
    return { linked: true, supersededAt };
  };

  if (options.db) return run(options.db);
  return withTransaction(run);
}

/**
 * The whole supersede chain `id` belongs to, oldest correction first, head last
 * — the "history remains queryable explicitly" half of §24.2 decision 4.
 *
 * Takes any member, not just the head or the tail: the caller of this is a
 * reader who was handed one memory and wants to know what came before and after
 * it, and requiring them to already hold the head would mean they had to walk
 * the chain to ask for the chain.
 *
 * Ordered by link distance rather than by `timestamp`. A correction can carry
 * an older timestamp than the memory it corrects — capture stamps mined
 * memories with their commit's date, so a repair sourced from an older commit
 * legitimately sorts before its predecessor — and the chain's meaning is the
 * link order, not the clock. `timestamp, id` only break ties between memories
 * that share a depth, which is the merge case below.
 *
 * ## Merges, and why the backward walk is seeded from the forward one
 *
 * The link is single-valued, so a chain cannot FORK forward — but two separate
 * memories can be retracted in favour of the SAME correction (`supersede(A, C)`
 * then `supersede(B, C)` are both legal, and both are the right thing for an
 * agent that found one correction answering two stale memories). The structure
 * is therefore a tree that converges on a head, not a line.
 *
 * A naive implementation walks back from the requested id and forward from it,
 * and unions the two. That returns `[A, C]` for `listSupersedeChain(A)` — `B`
 * is invisible, even though `A` and `B` were retracted by the same correction
 * and a reader asking "what did we believe before this" should see both. So the
 * backward walk is seeded from every id the FORWARD walk reached, which pulls
 * in the other branches of whatever the chain converges on, at the depth their
 * successor implies. `listSupersedeChain` then returns the same set from every
 * member, which is what its "takes any member" contract claims.
 *
 * Returns `[]` for an unknown id, and a single-element array for a memory that
 * neither supersedes nor is superseded — so a caller can render "history" the
 * same way regardless.
 */
export async function listSupersedeChain(id: string): Promise<Experience[]> {
  const { rows } = await getDb().query<ExperienceRow & { depth: number }>(
    `WITH RECURSIVE forward(id, depth) AS (
         SELECT id, 0 FROM experiences WHERE id = $1
       UNION
         SELECT e.superseded_by, f.depth + 1
           FROM experiences e JOIN forward f ON e.id = f.id
          WHERE e.superseded_by IS NOT NULL AND f.depth < ${MAX_CHAIN_DEPTH}
     ),
     chain(id, depth) AS (
         SELECT id, depth FROM forward
       UNION
         SELECT e.id, c.depth - 1
           FROM experiences e JOIN chain c ON e.superseded_by = c.id
          WHERE c.depth > -${MAX_CHAIN_DEPTH}
     )
     SELECT ${EXPERIENCE_COLUMNS_QUALIFIED}, c.depth
       FROM experiences e JOIN chain c ON e.id = c.id
      ORDER BY c.depth, e."timestamp", e.id`,
    [id]
  );
  return rows.map(rowToExperience);
}

/**
 * The current answer for a memory: follow `superseded_by` to the chain head.
 *
 * Returns the memory itself when nothing has replaced it, and `undefined` for
 * an unknown id. This is the lookup a caller holding a remembered id (a scout
 * report, a log line, an older context bundle) needs — that id keeps naming the
 * retracted text forever, and `getExperienceById` would hand it back with no
 * hint that it has been corrected.
 */
export async function getSupersedeHead(id: string): Promise<Experience | undefined> {
  const { rows } = await getDb().query<ExperienceRow>(
    `WITH RECURSIVE forward(id, depth) AS (
         SELECT id, 0 FROM experiences WHERE id = $1
       UNION ALL
         SELECT e.superseded_by, f.depth + 1
           FROM experiences e JOIN forward f ON e.id = f.id
          WHERE e.superseded_by IS NOT NULL AND f.depth < ${MAX_CHAIN_DEPTH}
     )
     SELECT ${EXPERIENCE_COLUMNS_QUALIFIED}
       FROM experiences e
      WHERE e.id = (SELECT id FROM forward ORDER BY depth DESC LIMIT 1)`,
    [id]
  );
  const row = rows[0];
  return row ? rowToExperience(row) : undefined;
}
