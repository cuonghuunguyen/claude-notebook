import { randomUUID } from "node:crypto";
import type { Edge, Provenance, RelationType } from "@cognitive-memory/core";
import {
  appendEvent,
  getEdgeByTriple,
  getPool,
  upsertEdgeByTriple,
} from "@cognitive-memory/graph-store";
import { computePromotion, type PromotionResult } from "./promotion.js";

export interface RecordObservationOptions {
  /** Passed through to computePromotion — see PromotionInput. */
  verified?: boolean;
  taskReferenceCount?: number;
  /** Only used when creating a brand-new edge; an existing edge keeps its current weight (spec.md §3.3: weight is recomputed from usage signals, not from a new observation). */
  initialWeight?: number;
}

const DEFAULT_INITIAL_WEIGHT = 0.5;

/**
 * Merges one new provenance record into a (from, to, relation) triple's
 * accumulated evidence, recomputes its promotion stage/confidence (spec.md
 * §7/§13), and persists the result through graph-store. This is the write
 * path packages/structural's `persist.ts` deliberately doesn't implement —
 * structural facts are `confidence: 1.0` and never need promotion; semantic
 * facts (this package) are the ones that start low and rise with
 * corroboration.
 *
 * `stage` is returned, not persisted: Edge (spec.md §3.3) has no "stage"
 * column, and adding one would relitigate an already-decided schema. Since
 * "observation"/"hypothesis" stages are exactly the ones spec.md §7 doesn't
 * want surfaced by default, and both necessarily carry confidence below the
 * "candidate" cap (§7: candidate requires ≥2-sourceType corroboration a lone
 * or non-diverse observation can't reach), a low-confidence filter at the
 * retrieval layer achieves the same effect as a persisted stage would.
 */
export async function recordObservation(
  from: string,
  to: string,
  relation: RelationType,
  provenance: Provenance,
  options: RecordObservationOptions = {}
): Promise<{ edge: Edge; promotion: PromotionResult }> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Read-merge-write on the same triple must be serialized: two concurrent
    // recordObservation calls (e.g. structural extraction and an inference
    // pass touching the same fact around the same time) can otherwise both
    // read the same snapshot and each write back a provenance array missing
    // the other's observation — confirmed as a real lost-update via a
    // race-simulation script against Postgres before this fix. A plain row
    // lock (SELECT ... FOR UPDATE) can't cover a brand-new triple that has
    // no row yet; an advisory lock keyed by the triple can, since it doesn't
    // require a row to exist. hashtext() is 32-bit, so distinct triples can
    // in principle collide onto the same lock key — that only costs
    // unnecessary serialization between unrelated triples, never a missed
    // lock, so it's safe.
    const lockKey = from.concat(" ", to, " ", relation);
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [lockKey]);

    // Run on `client` itself, not the shared pool — borrowing a second pool
    // connection here, while N concurrent calls each hold one client
    // blocked on the lock above, can exhaust the pool and deadlock (every
    // held connection waiting on a lock only a query on an unobtainable
    // connection could release).
    const existing = await getEdgeByTriple(from, to, relation, client);
    const mergedProvenance = existing ? [...existing.provenance, provenance] : [provenance];

    const promotion = computePromotion({
      provenance: mergedProvenance,
      verified: options.verified,
      taskReferenceCount: options.taskReferenceCount,
    });

    // Was this triple already durable BEFORE this observation was merged in
    // — via a prior explicit verification (existing.lastVerifiedAt, only
    // ever set below when a write actually reached "durable" through the
    // verified path) or via the taskReferenceCount path recomputed against
    // the pre-merge provenance? Needed for two things below: (1) only a
    // write that verifies AND actually lands on "durable" should update
    // lastVerifiedAt — setting it on e.g. a lone `verified: true`
    // observation that's nowhere near durable would make it a false
    // "promoted" signal for anything reading it as a proxy (packages/gc's
    // cold-storage marking); (2) ExperiencePromoted should fire on the
    // transition INTO durable, not on every subsequent write to an
    // already-durable triple.
    const wasAlreadyDurable =
      existing !== undefined &&
      (existing.lastVerifiedAt != null ||
        computePromotion({
          provenance: existing.provenance,
          taskReferenceCount: options.taskReferenceCount,
        }).stage === "durable");

    const now = new Date().toISOString();
    const reachedDurable = promotion.stage === "durable";
    const edge: Edge = {
      id: existing?.id ?? randomUUID(),
      from,
      to,
      relation,
      confidence: promotion.confidence,
      weight: existing?.weight ?? options.initialWeight ?? DEFAULT_INITIAL_WEIGHT,
      provenance: mergedProvenance,
      status: promotion.status,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastVerifiedAt: options.verified && reachedDurable ? now : existing?.lastVerifiedAt,
    };

    const saved = await upsertEdgeByTriple(edge, client);
    // spec.md §14: every semantic edge write is a RelationAdded event.
    // Appended on `client` (not the shared pool) so it commits/rolls back
    // atomically with the edge write above, inside the same advisory-lock-
    // guarded transaction.
    await appendEvent({ eventType: "RelationAdded", payload: { edge: saved } }, client);
    if (reachedDurable && !wasAlreadyDurable) {
      // spec.md §7/§14: this write is what carried the fact into "durable"
      // knowledge — distinct from RelationAdded (which fires on every write
      // to this triple, promoted or not). Only fires on the transition, not
      // on every later write to a triple that was already durable.
      await appendEvent(
        {
          eventType: "ExperiencePromoted",
          payload: { edgeId: saved.id, from, to, relation, stage: promotion.stage },
        },
        client
      );
    }
    await client.query("COMMIT");
    return { edge: saved, promotion };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
