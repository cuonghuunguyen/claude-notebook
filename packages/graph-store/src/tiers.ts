/**
 * Storage primitives for memory tiers (spec.md §24.5 / ROADMAP.md M16).
 *
 * This module is deliberately policy-free: it records accesses, settles them,
 * reports the aggregates a decision needs, and writes the decision back. What
 * counts as "enough" to promote lives in `packages/tiers`, which is pure and
 * unit-testable without a database — the same split `packages/semantic` uses
 * between its confidence maths and its edge writes.
 *
 * The one piece of policy that IS here is the one that has to be enforced by
 * the schema rather than by a function: an access is keyed by (memory,
 * session), so a session that retrieves the same memory forty times is still
 * one row. §24.5's "one chatty session can't self-promote a memory" is
 * therefore a primary-key property, not a check someone has to remember.
 */
import type { AccessOutcome, MemoryTier } from "@cognitive-memory/core";
import { getPool, type Queryable } from "./db.js";

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
  last_accessed: Date | null;
  confirmed_sessions: string;
  promotion_credit: string;
  rejected_since: string;
  credit_seq: string;
  writer_session: string | null;
  tier_changed_at: Date;
}

function rowToTierState(row: TierStateRow): TierState {
  return {
    id: row.id,
    tier: row.tier,
    accessCount: row.access_count,
    lastAccessed: row.last_accessed ? row.last_accessed.toISOString() : null,
    confirmedSessions: Number(row.confirmed_sessions),
    promotionCredit: Number(row.promotion_credit),
    rejectedSinceCredit: Number(row.rejected_since),
    creditSeq: Number(row.credit_seq),
    writerSession: row.writer_session,
    tierChangedAt: row.tier_changed_at.toISOString(),
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
 * neutral forever, so a session cannot promote what it just wrote.
 *
 * Returns the number of (memory, session) pairs touched.
 */
export async function recordExperienceAccesses(
  experienceIds: string[],
  sessionId: string,
  now: Date = new Date()
): Promise<number> {
  if (experienceIds.length === 0) return 0;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE experiences
          SET access_count = access_count + 1,
              last_accessed = GREATEST(COALESCE(last_accessed, $2::timestamptz), $2::timestamptz)
        WHERE id = ANY($1::text[])`,
      [experienceIds, now]
    );
    const { rowCount } = await client.query(
      `INSERT INTO experience_accesses
              (experience_id, session_id, outcome, hits, first_seen_at, last_seen_at)
       SELECT e.id,
              $2,
              CASE WHEN e.writer_session IS NOT DISTINCT FROM $2 THEN 'self' ELSE 'provisional' END,
              1, $3::timestamptz, $3::timestamptz
         FROM experiences e
        WHERE e.id = ANY($1::text[])
       ON CONFLICT (experience_id, session_id) DO UPDATE
          -- Outcome is deliberately NOT reset here. A session that retrieves
          -- the same memory again after its outcome was settled gets its hit
          -- counted and nothing else; re-opening a settled access would let a
          -- late read undo a rejection.
          SET hits = experience_accesses.hits + 1,
              last_seen_at = EXCLUDED.last_seen_at`,
      [experienceIds, sessionId, now]
    );
    await client.query("COMMIT");
    return rowCount ?? 0;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
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
 * Returns the ids whose accounting changed — hand them to
 * `packages/tiers`' transition pass.
 */
export async function settleSessionAccesses(
  sessionId: string,
  outcome: Extract<AccessOutcome, "confirmed" | "rejected">,
  options: SettleSessionOptions = {}
): Promise<string[]> {
  const now = options.now ?? new Date();
  const used = options.usedExperienceIds ?? null;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ experience_id: string }>(
      // A rejection applies to the whole retrieved set. A confirmation applies
      // only to explicitly named memories; everything else the session
      // retrieved settles `unused`, which is neutral — not `rejected`, because
      // "the caller did not tell us" is not evidence against a memory, and not
      // `confirmed`, because a green task is not evidence for one.
      `UPDATE experience_accesses
          SET outcome = CASE
                          WHEN $2 = 'rejected' THEN 'rejected'
                          WHEN $3::text[] IS NOT NULL AND experience_id = ANY($3::text[])
                            THEN 'confirmed'
                          ELSE 'unused'
                        END,
              settled_at = $4::timestamptz,
              settle_seq = nextval('experience_settle_seq')
        WHERE session_id = $1
          AND outcome = 'provisional'
       RETURNING experience_id`,
      [sessionId, outcome, used, now]
    );
    const ids = rows.map((r) => r.experience_id);
    if (ids.length > 0) {
      await client.query(
        `UPDATE experiences e
            SET distinct_sessions = (
                  SELECT count(*) FROM experience_accesses a
                   WHERE a.experience_id = e.id AND a.outcome = 'confirmed')
          WHERE e.id = ANY($1::text[])`,
        [ids]
      );
    }
    await client.query("COMMIT");
    return ids;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
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
 * the database rather than by hydrating access rows into JS — the decay pass
 * runs over the whole corpus, and the corpus is the part of this system that
 * grows without bound (spec.md §18).
 */
export async function listTierStates(options: ListTierStatesOptions): Promise<TierState[]> {
  const { rows } = await getPool().query<TierStateRow>(
    `SELECT e.id,
            e.tier,
            e.access_count,
            e.last_accessed,
            e.writer_session,
            e.tier_changed_at,
            COALESCE(c.confirmed_total, 0) AS confirmed_sessions,
            COALESCE(c.promotion_credit, 0) AS promotion_credit,
            COALESCE(c.credit_seq, 0) AS credit_seq,
            COALESCE(r.rejected_since, 0) AS rejected_since
       FROM experiences e
       LEFT JOIN LATERAL (
            SELECT count(*) AS confirmed_total,
                   -- Credit is what this memory has earned since the tier
                   -- change that last consumed its credit, bounded by the
                   -- sustained-access window. Consumption is by SEQUENCE, not
                   -- timestamp, so a confirmation sharing a millisecond with
                   -- the promotion it triggered is not silently voided.
                   count(*) FILTER (
                     WHERE settle_seq > e.credit_watermark
                       AND settled_at >= $2::timestamptz
                   ) AS promotion_credit,
                   COALESCE(max(settle_seq) FILTER (
                     WHERE settle_seq > e.credit_watermark
                       AND settled_at >= $2::timestamptz
                   ), e.credit_watermark) AS credit_seq,
                   max(settled_at) AS last_confirmed_at
              FROM experience_accesses
             WHERE experience_id = e.id AND outcome = 'confirmed'
       ) c ON true
       LEFT JOIN LATERAL (
            SELECT count(*) AS rejected_since
              FROM experience_accesses
             WHERE experience_id = e.id
               AND outcome = 'rejected'
               AND settled_at > GREATEST(e.tier_changed_at, COALESCE(c.last_confirmed_at, e.tier_changed_at))
       ) r ON true
      WHERE ($1::text[] IS NULL OR e.id = ANY($1::text[]))
        AND ($4::text IS NULL OR e.id > $4::text)
      ORDER BY e.id
      LIMIT $3`,
    [options.ids ?? null, options.windowStart, options.limit ?? 100_000, options.after ?? null]
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
  db: Queryable = getPool()
): Promise<number> {
  if (changes.length === 0) return 0;
  const { rowCount } = await db.query(
    // The watermark only ever moves forward (GREATEST), on promotions and
    // demotions alike: a demotion has to discard the credit that is no longer
    // valid, or the very next maintenance pass would re-promote the memory on
    // it and flap forever.
    `UPDATE experiences e
        SET tier = v.tier,
            tier_changed_at = $4::timestamptz,
            credit_watermark = GREATEST(e.credit_watermark, v.watermark)
       FROM (SELECT unnest($1::text[]) AS id,
                    unnest($2::text[]) AS tier,
                    unnest($3::bigint[]) AS watermark) v
      WHERE e.id = v.id AND e.tier IS DISTINCT FROM v.tier`,
    [
      changes.map((c) => c.id),
      changes.map((c) => c.tier),
      changes.map((c) => c.creditWatermark ?? 0),
      now,
    ]
  );
  return rowCount ?? 0;
}

/** Records which session wrote a memory, for §24.5's no-self-promotion rule. */
export async function setExperienceWriterSession(id: string, sessionId: string): Promise<void> {
  await getPool().query(`UPDATE experiences SET writer_session = $2 WHERE id = $1`, [id, sessionId]);
}

/** Tier histogram — the dogfood evidence ROADMAP.md M16 asks for. */
export async function getTierDistribution(): Promise<Record<MemoryTier, number>> {
  const { rows } = await getPool().query<{ tier: MemoryTier; count: string }>(
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
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT id FROM experiences
      WHERE tier = 'short'
        AND NOT cold
        AND COALESCE(last_accessed, tier_changed_at) < $1::timestamptz
      ORDER BY COALESCE(last_accessed, tier_changed_at)
      LIMIT $2`,
    [cutoff, limit]
  );
  return rows.map((r) => r.id);
}
