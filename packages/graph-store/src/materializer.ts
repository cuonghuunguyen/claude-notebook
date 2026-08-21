import { getPool } from "./db.js";
import { recordExperience, supersedeExperience } from "./experiences.js";
import type { MemoryEvent } from "./events.js";
import { listEventsSince } from "./events.js";

/**
 * spec.md §14: "the graph is a projection over persistent events." This
 * module is the projector — given the full event log (or any suffix of it),
 * it reproduces the exact sequence of raw graph-store writes the live code
 * paths (packages/episodic — see its appendEvent call sites) already
 * performed once, when those events were first created.
 *
 * Deliberately calls the same *raw* functions those call sites use
 * (`recordExperience`, `supersedeExperience`) rather than going back through
 * the owning package: that package's own logic already ran once to produce the
 * event, and replaying it would be re-deriving history rather than reproducing
 * it. A `MemoryEvent`'s payload carries exactly the already-decided result of
 * that logic.
 *
 * ## The structural event types are accepted and ignored, on purpose
 *
 * `SymbolAdded` / `CodeChanged` / `SymbolRemoved` / `RelationAdded` /
 * `RelationInvalidated` / `ExperiencePromoted` used to project into the
 * `nodes` and `edges` tables. M15 removed those tables along with everything
 * that could produce such an event — but an event log written before M15 is
 * append-only and still full of them, and this repository's own log is one of
 * those. Failing on an unknown-but-historical event type would mean
 * `rebuildFromEvents` throws on every database that has ever run a structural
 * extraction, i.e. exactly the databases a rebuild exists for. So they are
 * skipped explicitly, and the skip is counted (`replayEvents` returns it) so a
 * caller can see that a rebuild dropped a projection rather than silently
 * assuming a faithful replay.
 *
 * `InvariantLearned` / `DecisionRecorded` are skipped for the older reason:
 * spec.md §14 lists them in the event vocabulary and nothing has ever produced
 * one, so they are forward-compatible unknowns.
 *
 * ## Why "retired" and "unrecognised" are counted separately
 *
 * The obvious shape is one `skipped` counter fed by the switch's `default`.
 * That conflates two situations a caller must be able to tell apart: an event
 * whose projection this milestone deliberately dropped, and an event type this
 * code has never heard of — which can only mean the database was written by a
 * NEWER build than the one replaying it. The first is expected and benign; the
 * second means the rebuild is genuinely incomplete in a way nobody decided.
 * Reporting both as `skipped` would let a real projection loss hide inside a
 * number the doc comment describes as harmless, so `RETIRED_EVENT_TYPES` is
 * consulted rather than left as a set only a test reads.
 *
 * It does not throw on an unrecognised type. A rebuild exists to recover a
 * database, and refusing to finish because one row is from the future would
 * turn a partial recovery into no recovery — the same reasoning §24.2.3 uses
 * for flagging a doubtful memory instead of dropping it. The count is the
 * warning.
 *
 * Note where the vocabulary is actually enforced: `events_event_type_check`
 * (migration 0007) enumerates all ten §14 event types at the schema level. That
 * is the other reason `EventType` still names the retired six — dropping them
 * from the union would not stop the rows existing, and the constraint would
 * still accept them. It also means `unrecognised` is only reachable across
 * versions (an older build replaying a log a newer migration widened), never
 * from this build inserting.
 */
const RETIRED_EVENT_TYPES = new Set<MemoryEvent["eventType"]>([
  "SymbolAdded",
  "CodeChanged",
  "SymbolRemoved",
  "RelationAdded",
  "RelationInvalidated",
  "ExperiencePromoted",
  "InvariantLearned",
  "DecisionRecorded",
]);

type ApplyOutcome = "applied" | "retired" | "unrecognised";

async function applyEvent(event: MemoryEvent): Promise<ApplyOutcome> {
  switch (event.eventType) {
    case "ExperienceRecorded": {
      const { experience } = event.payload as { experience: Parameters<typeof recordExperience>[0] };
      await recordExperience(experience);
      return "applied";
    }
    case "ExperienceSuperseded": {
      // Idempotent by construction: `supersedeExperience` treats a link that
      // already points at the same successor as a no-op, so replaying the same
      // event twice (or replaying onto a database that already has the link)
      // is safe rather than an error.
      const { oldId, newId, supersededAt } = event.payload as {
        oldId: string;
        newId: string;
        supersededAt?: string;
      };
      await supersedeExperience(oldId, newId, { supersededAt });
      return "applied";
    }
    default:
      // Every remaining member of the §14 vocabulary is in RETIRED_EVENT_TYPES;
      // anything else came from a build newer than this one.
      return RETIRED_EVENT_TYPES.has(event.eventType) ? "retired" : "unrecognised";
  }
}

export interface ReplayResult {
  /** Events that produced a write. */
  applied: number;
  /** Events whose projection retired with the structural graph (M15), or that never had a producer. Expected on any database that ran an extraction. */
  skipped: number;
  /**
   * Events whose type this build does not know at all — i.e. the log was
   * written by a newer build. Non-zero means the rebuild is incomplete in a way
   * nobody chose, and is worth surfacing to whoever ran it; zero is the normal
   * case. Kept out of `skipped` so a real loss cannot hide inside an expected
   * number.
   */
  unrecognised: number;
}

/** Applies a batch of events in order. Callers own fetching the events (e.g. via `listEventsSince`). */
export async function replayEvents(events: MemoryEvent[]): Promise<ReplayResult> {
  const counts: ReplayResult = { applied: 0, skipped: 0, unrecognised: 0 };
  for (const event of events) {
    switch (await applyEvent(event)) {
      case "applied":
        counts.applied += 1;
        break;
      case "retired":
        counts.skipped += 1;
        break;
      case "unrecognised":
        counts.unrecognised += 1;
        break;
    }
  }
  return counts;
}

/** True for an event type whose projection was removed with the structural graph (M15). */
export function isRetiredEventType(eventType: MemoryEvent["eventType"]): boolean {
  return RETIRED_EVENT_TYPES.has(eventType);
}

/**
 * Empties the materialized memory tables WITHOUT touching `events` (the source
 * of truth this rebuilds from) or `schema_migrations`. `RESTART IDENTITY` on
 * `experiences` is moot — it uses text/hash ids, not sequences — kept off
 * deliberately since `events.id` (bigserial) must NOT be touched by this at all
 * and a blanket RESTART IDENTITY on unrelated tables is one less thing to
 * reason about being safe.
 *
 * `experience_accesses` (spec.md §24.5) is in the list for a reason worth
 * stating: it is read-telemetry, NOT event-sourced. Nothing in the event log
 * records a retrieval, so a rebuild cannot reconstruct it, and Postgres will
 * refuse to TRUNCATE `experiences` while a table referencing it is left out
 * — even an empty one. So a rebuild deliberately returns the corpus to "no
 * memory has been usefully accessed yet": accesses are dropped and every
 * `tier`/`distinct_sessions` on the replayed rows comes back at its column
 * default (`short`/0).
 *
 * That is a real consequence, not an oversight, and it is the *consistent*
 * choice — the alternative (keep the accounting, replay the memories) would
 * leave a memory sitting in long-term with the confirmed-session rows that
 * justified it now gone, i.e. a tier no surviving evidence supports. Tiers
 * re-earn themselves from live traffic instead, which is exactly the signal
 * §24.5 says a tier is supposed to represent.
 */
export async function wipeMaterializedGraph(): Promise<void> {
  const pool = getPool();
  await pool.query(`TRUNCATE TABLE experience_accesses, experiences`);
}

/** Full rebuild: wipe the materialized memory, replay every event ever recorded. */
export async function rebuildFromEvents(): Promise<ReplayResult> {
  await wipeMaterializedGraph();
  const events = await listEventsSince(0);
  return replayEvents(events);
}
