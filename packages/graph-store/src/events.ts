import { getPool } from "./db.js";

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

export async function appendEvent(event: MemoryEvent): Promise<MemoryEvent> {
  const pool = getPool();
  const { rows } = await pool.query<{
    id: number;
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
    id: row.id,
    eventType: row.event_type,
    payload: row.payload,
    occurredAt: row.occurred_at.toISOString(),
  };
}

export async function listEventsSince(id: number): Promise<MemoryEvent[]> {
  const pool = getPool();
  const { rows } = await pool.query<{
    id: number;
    event_type: EventType;
    payload: unknown;
    occurred_at: Date;
  }>(`SELECT id, event_type, payload, occurred_at FROM events WHERE id > $1 ORDER BY id ASC`, [
    id,
  ]);
  return rows.map((row) => ({
    id: row.id,
    eventType: row.event_type,
    payload: row.payload,
    occurredAt: row.occurred_at.toISOString(),
  }));
}
