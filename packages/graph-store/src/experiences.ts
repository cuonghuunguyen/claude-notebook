import type { Anchor, Experience, MemoryTier } from "@cognitive-memory/core";
import { anchorsFromRelatedNodes } from "@cognitive-memory/core";
import { getPool, type Queryable, type TransactionClient } from "./db.js";
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
  superseded_by: string | null;
  superseded_at: Date | null;
  verified_at: Date | null;
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
    supersededBy: row.superseded_by ?? undefined,
    supersededAt: row.superseded_at?.toISOString(),
    verifiedAt: row.verified_at?.toISOString(),
    confidence: row.confidence,
    timestamp: row.timestamp.toISOString(),
  };
}

const EXPERIENCE_COLUMNS = `id, task, observation, hypothesis, action, result, lessons, related_nodes, anchors, suspect, suspect_reason, superseded_by, superseded_at, verified_at, confidence, "timestamp", cold, tier`;

/**
 * The same column list qualified with the `e` alias, for the recursive-chain
 * queries that join `experiences` against a CTE which also has an `id` column
 * (Postgres rejects the unqualified list there as ambiguous). Derived rather
 * than written out twice so a future column cannot be added to one and not the
 * other.
 */
const EXPERIENCE_COLUMNS_QUALIFIED = EXPERIENCE_COLUMNS.split(", ")
  .map((column) => `e.${column}`)
  .join(", ");


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
  /**
   * spec.md §24.2 decision 4 / §24.6: a memory that read-repair has replaced
   * with a correction is excluded from default retrieval — the chain's head
   * answers. Set true for an explicit "what did we believe before" query.
   *
   * Applied to EVERY experience query in this module, not just the by-meaning
   * legs M13's acceptance names. A retracted memory that stays reachable
   * through by-node or by-task is retracted in name only, and those are the
   * paths `runPipeline` and the promotion pipeline read.
   */
  includeSuperseded?: boolean;
}

/**
 * The default-retrieval predicate shared by every query below, as SQL text.
 *
 * Written once because it is a policy, not a detail: "cold and superseded rows
 * are out unless explicitly asked for" has to hold identically across five
 * queries, and the previous copy-paste of the cold half is exactly how the
 * superseded half would come to be missing from one of them.
 *
 * `coldParam`/`supersededParam` are 1-based placeholder numbers supplied by the
 * caller — the callers' other parameters are already numbered, so this cannot
 * own the numbering.
 */
function defaultVisibility(coldParam: number, supersededParam: number): string {
  return `($${coldParam} OR NOT cold) AND ($${supersededParam} OR superseded_by IS NULL)`;
}

export async function queryExperiencesByNode(
  nodeId: string,
  options: ExperienceQueryOptions = {}
): Promise<Experience[]> {
  const pool = getPool();
  const { rows } = await pool.query<ExperienceRow>(
    `SELECT ${EXPERIENCE_COLUMNS} FROM experiences
     WHERE related_nodes @> $1::jsonb AND ${defaultVisibility(2, 3)}
     ORDER BY "timestamp" DESC`,
    [JSON.stringify([nodeId]), options.includeCold ?? false, options.includeSuperseded ?? false]
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
     WHERE task = $1 AND ${defaultVisibility(2, 3)}
     ORDER BY "timestamp" DESC`,
    [task, options.includeCold ?? false, options.includeSuperseded ?? false]
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
        AND ${defaultVisibility(3, 4)}
      ORDER BY score DESC, "timestamp" DESC, id
      LIMIT $2`,
    [tsQuery, limit, options.includeCold ?? false, options.includeSuperseded ?? false]
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
          AND ${defaultVisibility(3, 4)}
        ORDER BY score DESC, "timestamp" DESC, id
        LIMIT $2`,
      [query, limit, options.includeCold ?? false, options.includeSuperseded ?? false]
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
        AND ${defaultVisibility(3, 4)}
      ORDER BY embedding <=> $1, "timestamp" DESC, id
      LIMIT $2`,
    [toVectorLiteral(embedding), limit, options.includeCold ?? false, options.includeSuperseded ?? false]
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
      WHERE (anchors @> ANY ($1::jsonb[])
         OR related_nodes @> ANY ($2::jsonb[]))
        AND superseded_by IS NULL
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
  const { rowCount } = await getPool().query(
    `UPDATE experiences
        SET suspect = false, suspect_reason = NULL, verified_at = $2::timestamptz
      WHERE id = $1`,
    [id, verifiedAt]
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Recursion guard for the chain walks. A cycle is refused at write time and
 * forbidden by a CHECK, so this bound is only ever reached by data written
 * around this module — in which case a bounded wrong answer beats a query that
 * never returns. Far above any chain a real repair history produces.
 */
const MAX_CHAIN_DEPTH = 1000;

/**
 * Advisory-lock key serializing every `supersedeExperience` call. Arbitrary but
 * fixed, and distinct from `migrate.ts`'s key — any two processes using this
 * module agree on it, which is the whole point.
 */
const SUPERSEDE_LOCK_KEY = "4812003117260002";

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
 *    place. Also enforced by migration 0007's CHECK.
 *  - a memory already superseded by something ELSE: overwriting the pointer
 *    orphans the previous correction — it stays a head, so BOTH corrections
 *    answer, which is the fork the single-column design exists to prevent.
 *    Re-linking to the same successor is idempotent instead of an error, so a
 *    retried refine run is safe.
 *  - a cycle: if the correction is (transitively) already superseded by the
 *    memory being retired, linking closes a loop in which every member fails
 *    `superseded_by IS NULL` and the whole chain vanishes from retrieval.
 *
 * ## Why the whole operation takes one global lock
 *
 * `FOR UPDATE` on the old row serializes two runs racing on the SAME memory,
 * but the cycle check reads *other* rows, and under READ COMMITTED it cannot
 * see another transaction's uncommitted pointer. Two runs doing
 * `supersede(X, Y)` and `supersede(Y, X)` concurrently lock different rows and
 * each walks a snapshot in which the other's link does not exist, so both cycle
 * checks pass.
 *
 * What saves that case *without* this lock is not the check — it is migration
 * 0007's foreign key. Writing `superseded_by` takes a `FOR KEY SHARE` lock on
 * the referenced row, which conflicts with the other transaction's
 * `FOR UPDATE` on that same row, so the two updates deadlock and Postgres
 * kills one. Measured, not assumed: replaying the exact statement sequence on
 * two connections produces `deadlock detected` on one side and leaves a single
 * clean link behind. So a cycle cannot actually be committed today.
 *
 * That is a fine outcome to have and a bad one to rely on. It depends on an
 * implicit lock the FK happens to take, it surfaces as an opaque
 * `deadlock detected` rather than the specific refusal this function is written
 * to give, and it is not what any of the three refusals above says is
 * happening. A transaction-scoped advisory lock makes the check-then-write
 * genuinely atomic against every other supersede, so the loser waits and then
 * gets the real reason. Serializing all supersedes globally costs nothing —
 * a supersede is an agent-driven repair, not a hot path — and the lock dies
 * with its transaction, so a crashed run cannot wedge it.
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

  const run = async (db: TransactionClient): Promise<SupersedeResult> => {
    // Transaction-scoped, so it is released by COMMIT/ROLLBACK whatever
    // happens below — including a throw out of one of the refusals.
    await db.query("SELECT pg_advisory_xact_lock($1)", [SUPERSEDE_LOCK_KEY]);

    const { rows: oldRows } = await db.query<{ superseded_by: string | null }>(
      `SELECT superseded_by FROM experiences WHERE id = $1 FOR UPDATE`,
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
          SET superseded_by = $2, superseded_at = $3::timestamptz,
              suspect = false, suspect_reason = NULL
        WHERE id = $1`,
      [oldId, newId, supersededAt]
    );
    return { linked: true, supersededAt };
  };

  if (options.db) return run(options.db);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
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
  const { rows } = await getPool().query<ExperienceRow & { depth: number }>(
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
  const { rows } = await getPool().query<ExperienceRow>(
    `WITH RECURSIVE forward(id, depth) AS (
         SELECT id, 0 FROM experiences WHERE id = $1
       UNION ALL
         SELECT e.superseded_by, f.depth + 1
           FROM experiences e JOIN forward f ON e.id = f.id
          WHERE e.superseded_by IS NOT NULL AND f.depth < ${MAX_CHAIN_DEPTH}
     )
     SELECT ${EXPERIENCE_COLUMNS}
       FROM experiences e
      WHERE e.id = (SELECT id FROM forward ORDER BY depth DESC LIMIT 1)`,
    [id]
  );
  const row = rows[0];
  return row ? rowToExperience(row) : undefined;
}
