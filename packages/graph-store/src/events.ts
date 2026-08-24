import { getDb, type Queryable } from "./db.js";

/**
 * The spec.md §14 event vocabulary, in full.
 *
 * Deliberately still complete after M15: the first six members project into
 * the structural graph, which no longer exists, and no code can produce one
 * any more — but the log is append-only and every database that ever ran an
 * extraction still holds thousands of them, so the *type* has to keep naming
 * them or `listEventsSince` cannot describe its own rows. `materializer.ts`
 * skips them explicitly and counts the skips.
 */
export type EventType =
  | "CodeChanged"
  | "SymbolAdded"
  | "SymbolRemoved"
  | "RelationAdded"
  | "RelationInvalidated"
  | "InvariantLearned"
  | "DecisionRecorded"
  | "ExperienceRecorded"
  | "ExperiencePromoted"
  /**
   * Read-repair replaced a memory with a correction (spec.md §24.2 decision 4
   * / §24.6, M13). Eventful — unlike `cold` and `suspect`, which a rebuild can
   * recompute — because a replay that dropped it would put retracted knowledge
   * back into the default retrieval path.
   */
  | "ExperienceSuperseded";

export interface MemoryEvent<TPayload = unknown> {
  id?: number;
  eventType: EventType;
  payload: TPayload;
  occurredAt?: string;
}

/**
 * `db` defaults to the shared connection but accepts a `TransactionClient`, so
 * a caller appending an event as part of its own transaction (e.g. episodic's
 * `recordSupersedingExperience`, which writes the correction and its link
 * together) gets the event committed/rolled back atomically with the mutation
 * it describes, instead of the event surviving a rollback of the write it was
 * supposed to describe.
 *
 * `events.id` is `INTEGER PRIMARY KEY AUTOINCREMENT` (spec.md §25.5's
 * replacement for `bigserial`), which SQLite hands back as a JS number
 * directly. The explicit string->number conversion the Postgres driver needed —
 * node-postgres returns `bigint` columns as strings, and `id > $1` on the
 * un-widened string would have compared lexicographically once ids crossed a
 * digit boundary — is therefore gone, not forgotten.
 *
 * `payload` is TEXT holding JSON, so it is parsed here rather than by the
 * driver. `occurred_at` is already ISO-8601 UTC in the column (see `time.ts`),
 * so it is returned as-is instead of round-tripped through a Date.
 */
interface EventRow {
  id: number;
  event_type: EventType;
  payload: string;
  occurred_at: string;
}

function rowToEvent(row: EventRow): MemoryEvent {
  return {
    id: row.id,
    eventType: row.event_type,
    payload: JSON.parse(row.payload) as unknown,
    occurredAt: row.occurred_at,
  };
}

export async function appendEvent(
  event: MemoryEvent,
  db: Queryable = getDb()
): Promise<MemoryEvent> {
  const { rows } = await db.query<EventRow>(
    `INSERT INTO events (event_type, payload) VALUES ($1, $2)
     RETURNING id, event_type, payload, occurred_at`,
    [event.eventType, JSON.stringify(event.payload)]
  );
  const row = rows[0];
  if (!row) throw new Error("appendEvent: no row returned");
  return rowToEvent(row);
}

export async function listEventsSince(
  id: number,
  db: Queryable = getDb()
): Promise<MemoryEvent[]> {
  const { rows } = await db.query<EventRow>(
    `SELECT id, event_type, payload, occurred_at FROM events WHERE id > $1 ORDER BY id ASC`,
    [id]
  );
  return rows.map(rowToEvent);
}
