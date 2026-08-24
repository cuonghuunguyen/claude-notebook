/**
 * Storage primitives for memory tiers (spec.md §24.5 / ROADMAP.md M16).
 *
 * This module is deliberately policy-free: it records accesses, settles them,
 * reports the aggregates a decision needs, and writes the decision back. What
 * counts as "enough" to promote lives in `packages/tiers`, which is pure and
 * unit-testable without a database.
 *
 * The one piece of policy that IS here is the one that has to be enforced by
 * the schema rather than by a function: an access is keyed by (memory,
 * session), so a session that retrieves the same memory forty times is still
 * one row. §24.5's "one chatty session can't self-promote a memory" is
 * therefore a primary-key property, not a check someone has to remember.
 *
 * ## What the SQLite port changed here, and what it did not
 *
 * Three Postgres-only constructs from spec.md §25.5's table are all in this
 * file, and all three have exact replacements: `unnest($1::text[], ...)` became
 * `json_each` over one JSON array (which also removes the possibility of two
 * parallel arrays disagreeing in length), `count(*) FILTER (WHERE ...)` became a
 * correlated `count(*)` with the filter in its own WHERE, and
 * `IS NOT DISTINCT FROM` became `IS`, which is null-safe in SQLite. The
 * `LEFT JOIN LATERAL` aggregates became correlated scalar subqueries — the same
 * "compute the aggregate in the database, do not hydrate access rows into JS"
 * property, because the decay pass runs over the whole corpus and the corpus is
 * the part of this system that grows without bound (spec.md §18).
 *
 * `nextval('experience_settle_seq')` is the one that is not a pure rename; see
 * `settleSessionAccesses`.
 */
import type { AccessOutcome, MemoryTier } from "@cognitive-memory/core";
import { getDb, withTransaction, type Queryable } from "./db.js";
import { requireIsoUtc } from "./time.js";

/** Everything about a memory's tier standing that a decision reads. */
export interface TierState {
  id: string;
  tier: MemoryTier;
  /** Raw write-on-read hit count. Observational — nothing promotes on it (§24.5). */
  accessCount: number;
  /** Raw last-retrieved timestamp, any outcome. Decay reads this. */
  lastAccessed: string | null;
  /** Confirmed distinct sessions, all time. Reported for audit/eval; NOT what promotes. */
  confirmedSessions: number;
  /**
   * The promotion counter: confirmed distinct sessions settled *strictly
   * after* the memory entered its current tier, and no earlier than the
   * caller's sustained-access window.
   *
   * Strictly after, so the very access that triggered a promotion cannot also
   * pay for the next one — the memory has to earn each tier with fresh
   * evidence. And bounded by the window, so credit expires: that combination
   * is what stops an idle-demoted memory from being re-promoted by its own
   * ancient credit on the next maintenance pass.
   */
  promotionCredit: number;
  /**
   * Rejected sessions settled since the memory last did something right —
   * i.e. since `max(tierChangedAt, last confirmed access)`. Resets itself on
   * a tier change, which is why no separate column tracks it.
   */
  rejectedSinceCredit: number;
  /**
   * Highest `settle_seq` among the confirmed accesses currently counted as
   * credit. Becomes the memory's `credit_watermark` when a tier change
   * consumes that credit, which is what makes consumption exact instead of
   * timestamp-approximate.
   */
  creditSeq: number;
  /** The session that wrote the memory, if any. Mined memories have none. */
  writerSession: string | null;
  tierChangedAt: string;
}

interface TierStateRow {
  id: string;
  tier: MemoryTier;
  access_count: number;
  last_accessed: string | null;
  confirmed_sessions: number;
  promotion_credit: number;
  rejected_since: number;
  credit_seq: number;
  writer_session: string | null;
  tier_changed_at: string;
}

function rowToTierState(row: TierStateRow): TierState {
  return {
    id: row.id,
    tier: row.tier,
    accessCount: row.access_count,
    lastAccessed: row.last_accessed,
    confirmedSessions: Number(row.confirmed_sessions),
    promotionCredit: Number(row.promotion_credit),
    rejectedSinceCredit: Number(row.rejected_since),
    creditSeq: Number(row.credit_seq),
    writerSession: row.writer_session,
    tierChangedAt: row.tier_changed_at,
  };
}

/**
 * Write-on-read access accounting (§24.5's first bullet).
 *
 * Two writes, one transaction: the raw counters on `experiences`, and a
 * `provisional` row per (memory, session). Provisional is the important word
 * — this call moves nothing toward a promotion. Only `settleSessionAccesses`
 * can do that, and only once the session's task outcome is known, which is
 * the whole of M16's answer to "access is not correctness".
 *
 * An access by the memory's own writer session lands as `self` instead:
 * neutral forever, so a session cannot promote what it just wrote. The
 * null-safe comparison that decides this was `IS NOT DISTINCT FROM` and is now
 * plain `IS` (spec.md §25.5) — a mined memory has no writer session, and
 * `writer_session = $2` would be NULL rather than false for it, which would make
 * the CASE fall through to `provisional` by accident rather than by decision.
 *
 * Returns the number of (memory, session) pairs touched.
 */
export async function recordExperienceAccesses(
  experienceIds: string[],
  sessionId: string,
  now: Date = new Date()
): Promise<number> {
  if (experienceIds.length === 0) return 0;
  const ids = JSON.stringify(experienceIds);
  const at = now.toISOString();
  return withTransaction(async (tx) => {
    await tx.query(
      `UPDATE experiences
          SET access_count = access_count + 1,
              last_accessed = max(COALESCE(last_accessed, $2), $2)
        WHERE id IN (SELECT value FROM json_each($1))`,
      [ids, at]
    );
    const { rowCount } = await tx.query(
      `INSERT INTO experience_accesses
              (experience_id, session_id, outcome, hits, first_seen_at, last_seen_at)
       SELECT e.id,
              $2,
              CASE WHEN e.writer_session IS $2 THEN 'self' ELSE 'provisional' END,
              1, $3, $3
         FROM experiences e
        WHERE e.id IN (SELECT value FROM json_each($1))
       ON CONFLICT (experience_id, session_id) DO UPDATE
          -- Outcome is deliberately NOT reset here. A session that retrieves
          -- the same memory again after its outcome was settled gets its hit
          -- counted and nothing else; re-opening a settled access would let a
          -- late read undo a rejection.
          SET hits = experience_accesses.hits + 1,
              last_seen_at = excluded.last_seen_at`,
      [ids, sessionId, at]
    );
    return rowCount;
  });
}

export interface SettleSessionOptions {
  /**
   * The memories the session actually relied on (§24.5 candidate 3).
   *
   * Required for anything to be confirmed. Omitting it — or passing an empty
   * array — settles every retrieved memory `unused` (neutral), NOT
   * `confirmed`. See `settleSessionAccesses` for why.
   */
  usedExperienceIds?: string[];
  now?: Date;
}

/**
 * Settles every still-provisional access of one session, then recomputes the
 * confirmed-session tally for the memories it touched.
 *
 * ## The signal is deliberately asymmetric
 *
 * A failing task rejects EVERYTHING it retrieved; a passing task confirms only
 * what the caller explicitly names. That asymmetry is the correction to the
 * obvious design, and it is the difference between M16 gating promotion and
 * merely appearing to:
 *
 * A task's pass/fail verdict is a property of the TASK, not of each memory the
 * task happened to retrieve. Confirming everything a passing task touched
 * would make the promotion rule "any memory surfaced by a task whose tests
 * passed earns credit" — and since most tasks pass, that is a rounding error
 * away from the raw access counting §24.5 exists to rule out. A wrong memory
 * returned alongside nine right ones in three passing tasks would reach
 * long-term without ever having helped anyone.
 *
 * Failure, by contrast, IS informative about the whole retrieved set: the task
 * had this context and still went wrong, so none of it earns credit. Nothing
 * is claimed about which member was at fault, and nothing needs to be —
 * `rejected` withholds credit rather than asserting incorrectness.
 *
 * The consequence, stated plainly: with no caller supplying
 * `usedExperienceIds`, nothing in the corpus ever promotes. That is the
 * intended fail-closed behaviour — "a good memory promotes once someone
 * reports using it" is strictly cheaper than "a wrong memory promotes because
 * the tests were green for unrelated reasons".
 *
 * `distinct_sessions` is recomputed from `experience_accesses` rather than
 * incremented, because settle is not the only thing that can change it (a
 * cascade delete of an access row, a re-settle after a corrected outcome) and
 * a counter that can drift from its own source of truth is a counter that
 * eventually lies about which tier a memory earned.
 *
 * ## `settle_seq` without a sequence
 *
 * Postgres drew `settle_seq` from `nextval('experience_settle_seq')` *inside*
 * the UPDATE, which assigned a distinct value to every row it touched. SQLite
 * has no sequences, so spec.md §25.5 replaces it with a counter row bumped in
 * the same write transaction — which means every row of ONE settle shares ONE
 * value.
 *
 * That is a real difference and it changes nothing that reads the column, which
 * is why it is the chosen replacement rather than a compromise. A settle call
 * is per-session, so the granularity the watermark needs — "this session's
 * confirmation is newer than that session's" — is preserved exactly. Both
 * readers (`settle_seq > credit_watermark` and `max(settle_seq)`) treat one
 * settle's rows as a unit either way, because a tier change consumes all of
 * them together: with distinct seqs the watermark became the largest of them,
 * with a shared seq it becomes that same value.
 *
 * The bump happens whether or not any row is settled. A wasted counter value is
 * not observable — nothing reads the counter except as an opaque
 * monotonic stamp — and making the bump conditional would mean reading the
 * counter, then deciding, then writing it, i.e. exactly the race the
 * transaction exists to prevent.
 *
 * Returns the ids whose accounting changed — hand them to
 * `packages/tiers`' transition pass.
 */
export async function settleSessionAccesses(
  sessionId: string,
  outcome: Extract<AccessOutcome, "confirmed" | "rejected">,
  options: SettleSessionOptions = {}
): Promise<string[]> {
  const now = options.now ?? new Date();
  // `undefined` and `[]` are deliberately collapsed. Under Postgres the CASE
  // read `$3::text[] IS NOT NULL AND experience_id = ANY($3)`, and an empty
  // array makes the second half false — so a caller who passed `[]` and a
  // caller who passed nothing both settled everything `unused`. Passing `[]`
  // for both here keeps that behaviour and removes a null check that could
  // only ever have been true or false for the same outcome.
  const used = JSON.stringify(options.usedExperienceIds ?? []);
  return withTransaction(async (tx) => {
    const { rows: counter } = await tx.query<{ value: number }>(
      `UPDATE counters SET value = value + 1
        WHERE name = 'experience_settle_seq'
       RETURNING value`
    );
    const settleSeq = counter[0]?.value;
    if (settleSeq === undefined) {
      throw new Error("settleSessionAccesses: experience_settle_seq counter row is missing");
    }

    const { rows } = await tx.query<{ experience_id: string }>(
      // A rejection applies to the whole retrieved set. A confirmation applies
      // only to explicitly named memories; everything else the session
      // retrieved settles `unused`, which is neutral — not `rejected`, because
      // "the caller did not tell us" is not evidence against a memory, and not
      // `confirmed`, because a green task is not evidence for one.
      `UPDATE experience_accesses
          SET outcome = CASE
                          WHEN $2 = 'rejected' THEN 'rejected'
                          WHEN experience_id IN (SELECT value FROM json_each($3))
                            THEN 'confirmed'
                          ELSE 'unused'
                        END,
              settled_at = $4,
              settle_seq = $5
        WHERE session_id = $1
          AND outcome = 'provisional'
       RETURNING experience_id`,
      [sessionId, outcome, used, now.toISOString(), settleSeq]
    );
    const ids = rows.map((row) => row.experience_id);
    if (ids.length > 0) {
      await tx.query(
        `UPDATE experiences
            SET distinct_sessions = (
                  SELECT count(*) FROM experience_accesses a
                   WHERE a.experience_id = experiences.id AND a.outcome = 'confirmed')
          WHERE id IN (SELECT value FROM json_each($1))`,
        [JSON.stringify(ids)]
      );
    }
    return ids;
  });
}

export interface ListTierStatesOptions {
  /** Restrict to these memories. Omit to scan every memory (the decay pass). */
  ids?: string[];
  /** Start of the "sustained access" window bounding `promotionCredit`. */
  windowStart: Date;
  limit?: number;
  /**
   * Keyset cursor: return only memories whose id sorts after this one.
   *
   * The full-corpus decay pass needs this. Rows come back ordered by `id` and
   * capped by `limit`, so without a cursor a corpus larger than one page would
   * be silently truncated — and spec.md §18 is explicit that the experience
   * log is the part of this system that grows without bound. A cursor is used
   * rather than OFFSET because the pass writes tier changes as it goes;
   * OFFSET would shift rows underneath the scan, while `id` is immutable.
   */
  after?: string;
}

/**
 * One row per memory with every aggregate a tier decision needs, computed in
 * the database rather than by hydrating access rows into JS.
 */
export async function listTierStates(options: ListTierStatesOptions): Promise<TierState[]> {
  const windowStart = options.windowStart.toISOString();
  const { rows } = await getDb().query<TierStateRow>(
    `SELECT e.id,
            e.tier,
            e.access_count,
            e.last_accessed,
            e.writer_session,
            e.tier_changed_at,
            (SELECT count(*) FROM experience_accesses a
              WHERE a.experience_id = e.id AND a.outcome = 'confirmed') AS confirmed_sessions,
            -- Credit is what this memory has earned since the tier change that
            -- last consumed its credit, bounded by the sustained-access window.
            -- Consumption is by SEQUENCE, not timestamp, so a confirmation
            -- sharing a millisecond with the promotion it triggered is not
            -- silently voided.
            (SELECT count(*) FROM experience_accesses a
              WHERE a.experience_id = e.id AND a.outcome = 'confirmed'
                AND a.settle_seq > e.credit_watermark
                AND a.settled_at >= $2) AS promotion_credit,
            (SELECT COALESCE(max(a.settle_seq), e.credit_watermark)
               FROM experience_accesses a
              WHERE a.experience_id = e.id AND a.outcome = 'confirmed'
                AND a.settle_seq > e.credit_watermark
                AND a.settled_at >= $2) AS credit_seq,
            (SELECT count(*) FROM experience_accesses a
              WHERE a.experience_id = e.id AND a.outcome = 'rejected'
                AND a.settled_at > max(
                      e.tier_changed_at,
                      COALESCE((SELECT max(c.settled_at) FROM experience_accesses c
                                 WHERE c.experience_id = e.id AND c.outcome = 'confirmed'),
                               e.tier_changed_at))) AS rejected_since
       FROM experiences e
      WHERE ($1 IS NULL OR e.id IN (SELECT value FROM json_each($1)))
        AND ($4 IS NULL OR e.id > $4)
      ORDER BY e.id
      LIMIT $3`,
    [
      options.ids ? JSON.stringify(options.ids) : null,
      windowStart,
      options.limit ?? 100_000,
      options.after ?? null,
    ]
  );
  return rows.map(rowToTierState);
}

/** Convenience read for one memory — tests and the dogfood harness. */
export async function getTierState(
  id: string,
  windowStart: Date = new Date(0)
): Promise<TierState | undefined> {
  const [state] = await listTierStates({ ids: [id], windowStart });
  return state;
}

/**
 * Writes decided tier changes. `tier_changed_at` moves with the tier, which
 * is what resets `rejectedSinceCredit` — see `TierState`.
 */
export async function applyTierChanges(
  changes: ReadonlyArray<{ id: string; tier: MemoryTier; creditWatermark?: number }>,
  now: Date = new Date(),
  db: Queryable = getDb()
): Promise<number> {
  if (changes.length === 0) return 0;
  const { rowCount } = await db.query(
    // The watermark only ever moves forward (`max` of the two), on promotions
    // and demotions alike: a demotion has to discard the credit that is no
    // longer valid, or the very next maintenance pass would re-promote the
    // memory on it and flap forever.
    //
    // `e.tier IS NOT v.tier` is spec.md §25.5's replacement for
    // `IS DISTINCT FROM` — SQLite's `IS` is the null-safe comparison, and both
    // sides are NOT NULL here anyway, so this is a rename rather than a change.
    `UPDATE experiences AS e
        SET tier = v.tier,
            tier_changed_at = $2,
            credit_watermark = max(e.credit_watermark, v.watermark)
       FROM (SELECT json_extract(value, '$.id') AS id,
                    json_extract(value, '$.tier') AS tier,
                    json_extract(value, '$.watermark') AS watermark
               FROM json_each($1)) v
      WHERE e.id = v.id AND e.tier IS NOT v.tier`,
    [
      JSON.stringify(
        changes.map((change) => ({
          id: change.id,
          tier: change.tier,
          watermark: change.creditWatermark ?? 0,
        }))
      ),
      now.toISOString(),
    ]
  );
  return rowCount;
}

/** Records which session wrote a memory, for §24.5's no-self-promotion rule. */
export async function setExperienceWriterSession(id: string, sessionId: string): Promise<void> {
  await getDb().query(`UPDATE experiences SET writer_session = $2 WHERE id = $1`, [id, sessionId]);
}

/** Tier histogram — the dogfood evidence ROADMAP.md M16 asks for. */
export async function getTierDistribution(): Promise<Record<MemoryTier, number>> {
  const { rows } = await getDb().query<{ tier: MemoryTier; count: number }>(
    `SELECT tier, count(*) AS count FROM experiences GROUP BY tier`
  );
  const distribution: Record<MemoryTier, number> = { short: 0, mid: 0, long: 0 };
  for (const row of rows) distribution[row.tier] = Number(row.count);
  return distribution;
}

/**
 * Short-term memories nobody has retrieved since `cutoff` — spec.md §18 GC
 * candidates via §24.5's decay rule.
 *
 * The fallback for a never-retrieved memory is `tier_changed_at` (which for a
 * never-promoted memory is when the row was written), NOT the experience's own
 * `timestamp`. The two differ by design since §24.2.1: a memory mined from a
 * two-year-old commit carries the *commit's* date, so measuring idleness from
 * `timestamp` would make every mined memory a GC candidate the instant it was
 * captured, before any session could possibly have retrieved it. Idleness has
 * to be measured from when the memory became available to retrieve.
 *
 * Only `tier = 'short'` is ever returned: mid-term memories decay to short
 * first and get another window, and long-term is never GC'd for coldness at
 * all (§24.5), which is enforced here rather than left to the caller.
 */
export async function listIdleShortTermExperienceIds(
  cutoff: Date,
  limit = 1000
): Promise<string[]> {
  const { rows } = await getDb().query<{ id: string }>(
    `SELECT id FROM experiences
      WHERE tier = 'short'
        AND NOT cold
        AND COALESCE(last_accessed, tier_changed_at) < $1
      ORDER BY COALESCE(last_accessed, tier_changed_at)
      LIMIT $2`,
    [requireIsoUtc(cutoff), limit]
  );
  return rows.map((row) => row.id);
}
