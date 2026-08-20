import type { Anchor, Experience, MemoryTier } from "@cognitive-memory/core";
import { anchorsFromRelatedNodes } from "@cognitive-memory/core";
import { getPool, type Queryable } from "./db.js";
import { toVectorLiteral } from "./vector.js";

interface ExperienceRow {
  id: string;
  task: string;
  observation: string;
  hypothesis: string | null;
  action: string | null;
  result: string | null;
  lessons: string[];
  related_nodes: string[];
  anchors: Anchor[];
  suspect: boolean;
  suspect_reason: string | null;
  confidence: number;
  timestamp: Date;
  cold: boolean;
  /** spec.md §24.5. Read out onto search hits, never onto `Experience` — tier is storage/ranking metadata, not part of §8's contract. */
  tier: MemoryTier;
}

interface ScoredExperienceRow extends ExperienceRow {
  score: number;
}

function rowToExperience(row: ExperienceRow): Experience {
  return {
    id: row.id,
    task: row.task,
    observation: row.observation,
    hypothesis: row.hypothesis ?? undefined,
    action: row.action ?? undefined,
    result: row.result ?? undefined,
    lessons: row.lessons,
    relatedNodes: row.related_nodes,
    // A memory written before migration 0006 has an empty `anchors` column but
    // may well carry paths in `related_nodes` (M11's capture put them there).
    // Falling back keeps every pre-M12 memory checkable by the §24.2.3
    // staleness pass instead of silently exempting it — and it is a read-time
    // derivation, so nothing is rewritten and the fallback stays reversible.
    anchors: row.anchors.length > 0 ? row.anchors : anchorsFromRelatedNodes(row.related_nodes),
    suspect: row.suspect,
    suspectReason: row.suspect_reason ?? undefined,
    confidence: row.confidence,
    timestamp: row.timestamp.toISOString(),
  };
}

const EXPERIENCE_COLUMNS = `id, task, observation, hypothesis, action, result, lessons, related_nodes, anchors, suspect, suspect_reason, confidence, "timestamp", cold, tier`;

/**
 * Append-only per spec.md §8 — there is deliberately no update/delete
 * export in this module. If you need to "correct" an experience, record a
 * new one; the promotion pipeline (M3) reasons over the full history.
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
  db: Queryable = getPool(),
  options: RecordExperienceOptions = {}
): Promise<Experience> {
  const { rows } = await db.query<ExperienceRow>(
    `
    INSERT INTO experiences (id, task, observation, hypothesis, action, result, lessons, related_nodes, anchors, confidence, "timestamp", writer_session)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11::timestamptz, now()), $12)
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
      // Previously omitted, so the column always fell back to its `DEFAULT
      // now()` and every caller-supplied timestamp was silently dropped.
      // That is load-bearing for spec.md §24 capture: a memory mined from git
      // history must carry the *commit's* date, or §24.2.3's "is the last
      // commit touching my anchors newer than this memory?" staleness test is
      // meaningless — every mined memory would look newer than the history it
      // was mined from.
      experience.timestamp ?? null,
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
}

export async function queryExperiencesByNode(
  nodeId: string,
  options: ExperienceQueryOptions = {}
): Promise<Experience[]> {
  const pool = getPool();
  const { rows } = await pool.query<ExperienceRow>(
    `SELECT ${EXPERIENCE_COLUMNS} FROM experiences
     WHERE related_nodes @> $1::jsonb AND ($2 OR NOT cold)
     ORDER BY "timestamp" DESC`,
    [JSON.stringify([nodeId]), options.includeCold ?? false]
  );
  return rows.map(rowToExperience);
}

export async function queryExperiencesByTask(
  task: string,
  options: ExperienceQueryOptions = {}
): Promise<Experience[]> {
  const pool = getPool();
  const { rows } = await pool.query<ExperienceRow>(
    `SELECT ${EXPERIENCE_COLUMNS} FROM experiences
     WHERE task = $1 AND ($2 OR NOT cold)
     ORDER BY "timestamp" DESC`,
    [task, options.includeCold ?? false]
  );
  return rows.map(rowToExperience);
}

/**
 * spec.md §18: mark an experience cold once its lessons have been promoted
 * to a durable semantic edge — still queryable via `includeCold`, just out
 * of the default hot path. Pure status flip, no event: unlike
 * `RelationInvalidated`, cold/hot is not part of the spec.md §14 event
 * vocabulary, and nothing about the experience's own content changed.
 */
export async function markExperienceCold(id: string): Promise<void> {
  const pool = getPool();
  await pool.query(`UPDATE experiences SET cold = true WHERE id = $1`, [id]);
}

/** id + relatedNodes only, for packages/gc's cold-eligibility scan — avoids hydrating full experience rows just to inspect one field. */
export async function listWarmExperienceRefs(): Promise<
  Array<{ id: string; relatedNodes: string[] }>
> {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string; related_nodes: string[] }>(
    `SELECT id, related_nodes FROM experiences WHERE NOT cold`
  );
  return rows.map((row) => ({ id: row.id, relatedNodes: row.related_nodes }));
}


// ---------------------------------------------------------------------------
// Content search over knowledge (spec.md §24.2.1 / ROADMAP.md M11).
//
// The three functions below are the storage primitives for by-meaning
// retrieval: they find an experience by what it *says*, with no reference to
// any structural node. `packages/episodic`'s `queryByMeaning` composes them
// into one hybrid query, mirroring how `packages/retrieval` composes
// `searchNodesByTrigram` + `searchNodesByEmbedding` for §9.
//
// Every one of them honours §18's cold flag the same way the by-node/by-task
// queries do — a memory whose lessons were already promoted to a durable edge
// stays out of the default hot path unless explicitly asked for.
// ---------------------------------------------------------------------------

/** The searched text: exactly what migration 0004's indexes are built over. */
const EXPERIENCE_TEXT = `(task || ' ' || observation)`;

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
 * Full-text leg. `tsQuery` is a ready-made `tsquery` *string* rather than a
 * raw question, because the useful query shape here is caller policy, not
 * storage policy: WHY_MEMORY_SPIKE.md's 0.75 came from OR-joining the
 * question's content words (a "why" question shares only a few terms with the
 * commit body that answers it), which neither `plainto_tsquery` nor
 * `websearch_to_tsquery` produces — both AND their terms. `packages/episodic`
 * owns that construction; this function owns the ranking.
 *
 * Passing an empty string returns nothing rather than throwing, so a question
 * made entirely of stopwords degrades to "no lexical hits".
 */
export async function searchExperiencesByFullText(
  tsQuery: string,
  limit = 10,
  options: ExperienceQueryOptions = {}
): Promise<ExperienceSearchHit[]> {
  if (!tsQuery.trim()) return [];
  const { rows } = await getPool().query<ScoredExperienceRow>(
    `SELECT ${EXPERIENCE_COLUMNS},
            ts_rank(to_tsvector('english', ${EXPERIENCE_TEXT}), to_tsquery('english', $1)) AS score
       FROM experiences
      WHERE to_tsvector('english', ${EXPERIENCE_TEXT}) @@ to_tsquery('english', $1)
        AND ($3 OR NOT cold)
      ORDER BY score DESC, "timestamp" DESC, id
      LIMIT $2`,
    [tsQuery, limit, options.includeCold ?? false]
  );
  return rows.map(rowToHit);
}

/**
 * Trigram leg (spec.md §9's `pg_trgm` choice, pointed at experience text).
 *
 * Uses `word_similarity` / `<%` rather than `similarity` / `%`: whole-string
 * trigram similarity between a one-line question and a multi-paragraph commit
 * body is always near zero, so `%` would return nothing useful. Word similarity
 * asks the question §9 actually cares about — how well does the query match the
 * best-matching *extent* of this text.
 *
 * `query` is the caller's whole question, deliberately. That means this leg is
 * a character-level whole-question matcher, not the per-identifier rescue an
 * earlier draft of this comment claimed: it will find a body that shares an
 * unstemmed spelling with the question (`regexes.ts`, `$ZodCatch`, `__proto__`)
 * because those trigrams push the score up, but it does not isolate those
 * fragments and score them on their own. Measured on a real eval pair,
 * whole-question word similarity against the answering body was 0.49 against a
 * 0.35 floor, while the isolated identifier scored 0.83 — so isolating terms
 * would be a genuinely stronger leg, and is left as a follow-up rather than
 * asserted here as already done.
 *
 * The `<%` operator reads its threshold from a GUC, so a GUC is the only way to
 * feed it. It is set with `set_config(..., is_local => true)` inside an
 * explicit transaction, so the setting dies with the transaction rather than
 * riding along on a pooled connection for the rest of its life. (This is
 * deliberately *not* what `searchNodesByTrigram` does — `set_limit()` sets a
 * different GUC, `pg_trgm.similarity_threshold` for `%`, and leaks it
 * session-wide. That is pre-existing and out of scope here, but it is not a
 * precedent worth copying.)
 */
export async function searchExperiencesByTrigram(
  query: string,
  limit = 10,
  threshold = 0.35,
  options: ExperienceQueryOptions = {}
): Promise<ExperienceSearchHit[]> {
  if (!query.trim()) return [];
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('pg_trgm.word_similarity_threshold', $1, true)", [
      String(threshold),
    ]);
    const { rows } = await client.query<ScoredExperienceRow>(
      `SELECT ${EXPERIENCE_COLUMNS}, word_similarity($1, ${EXPERIENCE_TEXT}) AS score
         FROM experiences
        WHERE $1 <% ${EXPERIENCE_TEXT}
          AND ($3 OR NOT cold)
        ORDER BY score DESC, "timestamp" DESC, id
        LIMIT $2`,
      [query, limit, options.includeCold ?? false]
    );
    await client.query("COMMIT");
    return rows.map(rowToHit);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Vector leg. Mirrors `searchNodesByEmbedding` exactly, including `1 - (a <=>
 * b)` as the score so cosine *similarity* (higher is better) is what callers
 * see, not cosine distance.
 */
export async function searchExperiencesByEmbedding(
  embedding: number[],
  limit = 10,
  options: ExperienceQueryOptions = {}
): Promise<ExperienceSearchHit[]> {
  const { rows } = await getPool().query<ScoredExperienceRow>(
    `SELECT ${EXPERIENCE_COLUMNS}, 1 - (embedding <=> $1) AS score
       FROM experiences
      WHERE embedding IS NOT NULL
        AND ($3 OR NOT cold)
      ORDER BY embedding <=> $1, "timestamp" DESC, id
      LIMIT $2`,
    [toVectorLiteral(embedding), limit, options.includeCold ?? false]
  );
  return rows.map(rowToHit);
}

/**
 * Writes the embedding the vector leg searches. Separate from
 * `recordExperience` for the same reason `upsertNodeEmbedding` is separate
 * from `upsertNode` (spec.md §9): computing it is the caller's business via
 * an injected provider, and a capture run without an embedder must still be
 * able to write the memory.
 *
 * This is the one write that touches an existing experience row, and it is
 * still consistent with spec.md §8's append-only rule: it adds a derived
 * search index for content that never changes, not a correction to what the
 * experience says. (Corrections are M13's `supersedes` chain.)
 */
export async function upsertExperienceEmbedding(id: string, embedding: number[]): Promise<void> {
  await getPool().query(`UPDATE experiences SET embedding = $2 WHERE id = $1`, [
    id,
    toVectorLiteral(embedding),
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
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT id FROM experiences WHERE embedding IS NULL ORDER BY "timestamp" LIMIT $1`,
    [limit]
  );
  return rows.map((r) => r.id);
}

/** Full text of one experience, for computing its embedding. */
export async function getExperienceById(id: string): Promise<Experience | undefined> {
  const { rows } = await getPool().query<ExperienceRow>(
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
  const { rows } = await getPool().query<{ action: string }>(
    `SELECT DISTINCT action FROM experiences WHERE action IS NOT NULL AND action LIKE $1 || '%'`,
    [prefix]
  );
  return rows.map((r) => r.action);
}

// ---------------------------------------------------------------------------
// Text anchors + commit-triggered staleness (spec.md §24.2.2-§24.2.3 /
// ROADMAP.md M12).
// ---------------------------------------------------------------------------

/**
 * Memories anchored to any of `paths` — the query the sync-time staleness pass
 * runs once per batch of changed paths.
 *
 * Uses jsonb containment (`anchors @> '[{"path": ...}]'`) so migration 0006's
 * GIN index does the work. Containment is per-object subset matching, so a
 * path-level trigger also finds `{ path, symbol }` anchors on that path — which
 * is exactly M12's file-level trigger semantics, for free.
 *
 * `OR` across paths in one statement rather than one statement per path: a
 * commit range can touch hundreds of files, and the caller wants one round trip.
 *
 * The second leg over `related_nodes` is the pre-M12 half, and it is not
 * optional: every memory M11's capture recorded has its paths ONLY in
 * `related_nodes`, so an `anchors`-only predicate would make the entire existing
 * corpus permanently invisible to the staleness pass — the flag would work only
 * for memories written after this migration. `rowToExperience` already derives
 * anchors from `related_nodes` on read; this is the same fallback pushed down to
 * the lookup so those memories are candidates in the first place. It rides
 * migration 0001's `experiences_related_nodes_idx`, so it costs an index scan,
 * not a table scan.
 *
 * One asymmetry to know about: `related_nodes` holds anchors in *text* form, so
 * this leg matches a bare path exactly and will not find a legacy
 * `path#symbol` entry from a path-level trigger. New writes populate `anchors`
 * where containment handles that case properly; nothing is silently wrong, the
 * older form is just coarser.
 *
 * Cold memories are INCLUDED here, unlike every retrieval query in this module.
 * §18's cold flag governs what retrieval surfaces by default; it says nothing
 * about whether a memory is still true. A cold memory that `includeCold` later
 * brings back must not carry a staleness verdict that silently stopped being
 * maintained while it was out of the hot path.
 */
export async function listExperiencesByAnchorPaths(paths: readonly string[]): Promise<Experience[]> {
  const distinct = [...new Set(paths.filter((p) => p.trim().length > 0))];
  if (distinct.length === 0) return [];
  const { rows } = await getPool().query<ExperienceRow>(
    `SELECT ${EXPERIENCE_COLUMNS} FROM experiences
      WHERE anchors @> ANY ($1::jsonb[])
         OR related_nodes @> ANY ($2::jsonb[])
      ORDER BY "timestamp" DESC, id`,
    [
      distinct.map((path) => JSON.stringify([{ path }])),
      distinct.map((path) => JSON.stringify([path])),
    ]
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
 * One statement for the whole batch via `unnest`, so marking 300 memories after
 * a big merge is one round trip rather than 300. Idempotent — re-running the
 * same sync re-writes the same verdict.
 */
export async function markExperiencesSuspect(
  entries: ReadonlyArray<{ id: string; reason: string }>
): Promise<number> {
  if (entries.length === 0) return 0;
  const { rowCount } = await getPool().query(
    `UPDATE experiences AS e
        SET suspect = true, suspect_reason = v.reason
       FROM unnest($1::text[], $2::text[]) AS v(id, reason)
      WHERE e.id = v.id`,
    [entries.map((e) => e.id), entries.map((e) => e.reason)]
  );
  return rowCount ?? 0;
}

/**
 * Clears the suspect flag on one memory.
 *
 * M12 never calls this — nothing in this milestone can establish that a
 * suspect memory is actually still correct, and pretending otherwise is how a
 * staleness system starts lying. It exists because M13's read-repair is the
 * step that CAN establish it (verify against current code, then either clear or
 * supersede), and leaving the setter without its inverse would make that
 * milestone's first move a schema change instead of a behaviour change.
 */
export async function clearExperienceSuspect(id: string): Promise<void> {
  await getPool().query(
    `UPDATE experiences SET suspect = false, suspect_reason = NULL WHERE id = $1`,
    [id]
  );
}
