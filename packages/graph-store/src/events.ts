import { getPool, type Queryable } from "./db.js";

/** Event types the materializer replays — spec.md §14. */
export type EventType =
  | "CodeChanged"
  | "SymbolAdded"
  | "SymbolRemoved"
  | "RelationAdded"
  | "RelationInvalidated"
  | "InvariantLearned"
  | "DecisionRecorded"
  | "ExperienceRecorded"
  | "ExperiencePromoted";

export interface MemoryEvent<TPayload = unknown> {
  id?: number;
  eventType: EventType;
  payload: TPayload;
  occurredAt?: string;
}

// `events.id` is `bigserial` (bigint); node-postgres returns bigint columns
// as strings (it can't safely widen them to JS `number` without risking
// precision loss), but `MemoryEvent.id` is declared `number` and callers
// compare ids with `>`. Converting explicitly here is safe: event ids won't
// approach Number.MAX_SAFE_INTEGER in this system's lifetime, and without
// the conversion `id > $1` on the un-widened string would silently do
// lexicographic comparison (`"10" > "9"` is false) once ids cross a digit
// boundary.
function toEventId(id: string): number {
  return Number(id);
}

/**
 * `db` defaults to the shared pool but accepts a checked-out `PoolClient` —
 * same pattern as edges.ts's `upsertEdgeByTriple` — so a caller appending an
 * event as part of its own transaction (e.g. semantic's advisory-lock-
 * guarded recordObservation) gets the event committed/rolled back atomically
 * with the mutation it describes, instead of the event surviving a rollback
 * of the write it was supposed to describe.
 */
export async function appendEvent(event: MemoryEvent, db: Queryable = getPool()): Promise<MemoryEvent> {
  const { rows } = await db.query<{
    id: string;
    event_type: EventType;
    payload: unknown;
    occurred_at: Date;
  }>(
    `INSERT INTO events (event_type, payload) VALUES ($1, $2)
     RETURNING id, event_type, payload, occurred_at`,
    [event.eventType, JSON.stringify(event.payload)]
  );
  const row = rows[0];
  if (!row) throw new Error("appendEvent: no row returned");
  return {
    id: toEventId(row.id),
    eventType: row.event_type,
    payload: row.payload,
    occurredAt: row.occurred_at.toISOString(),
  };
}

export async function listEventsSince(id: number, db: Queryable = getPool()): Promise<MemoryEvent[]> {
  const { rows } = await db.query<{
    id: string;
    event_type: EventType;
    payload: unknown;
    occurred_at: Date;
  }>(`SELECT id, event_type, payload, occurred_at FROM events WHERE id > $1 ORDER BY id ASC`, [
    id,
  ]);
  return rows.map((row) => ({
    id: toEventId(row.id),
    eventType: row.event_type,
    payload: row.payload,
    occurredAt: row.occurred_at.toISOString(),
  }));
}
