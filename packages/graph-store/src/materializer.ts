import { getPool } from "./db.js";
import { markEdgeInvalid, markEdgesStaleForNode, upsertEdgeByTriple } from "./edges.js";
import { recordExperience } from "./experiences.js";
import type { MemoryEvent } from "./events.js";
import { listEventsSince } from "./events.js";
import { markNodeDeleted, upsertNode } from "./nodes.js";

/**
 * spec.md §14: "the graph is a projection over persistent events." This
 * module is the projector — given the full event log (or any suffix of it),
 * it reproduces the exact sequence of raw graph-store writes the live code
 * paths (packages/structural, semantic, episodic — see their appendEvent
 * call sites) already performed once, when those events were first created.
 *
 * Deliberately calls the same *raw* functions those call sites use
 * (upsertNode, markEdgesStaleForNode, upsertEdgeByTriple, ...) rather than
 * going back through packages/structural etc. — those packages' own logic
 * (ts-morph extraction, promotion-table computation) already ran once to
 * produce the event; replaying it would be re-deriving history, not
 * reproducing it. A `MemoryEvent`'s payload carries exactly the already-
 * decided result of that logic.
 *
 * `ExperiencePromoted`/`InvariantLearned`/`DecisionRecorded` are handled as
 * no-ops: `ExperiencePromoted` fires alongside a `RelationAdded` for the same
 * edge (semantic/edge.ts), which already replays the actual data; the other
 * two currently have no producer anywhere in the codebase (see spec.md §14's
 * event vocabulary vs. what's actually wired) and are accepted here as
 * forward-compatible unknowns rather than causing replay to fail on them.
 */
async function applyEvent(event: MemoryEvent): Promise<void> {
  switch (event.eventType) {
    case "SymbolAdded": {
      const { node, repoId } = event.payload as { node: Parameters<typeof upsertNode>[0]; repoId: string };
      await upsertNode(node, repoId);
      return;
    }
    case "CodeChanged": {
      const { node, repoId } = event.payload as { node: Parameters<typeof upsertNode>[0]; repoId: string };
      await upsertNode(node, repoId);
      // Mirrors persist.ts's live-path side effect: a structural change
      // marks this node's dependent (semantic) edges stale for
      // re-verification (spec.md §12) — not itself a separate event.
      await markEdgesStaleForNode(node.id);
      return;
    }
    case "SymbolRemoved": {
      const { id } = event.payload as { id: string };
      await markNodeDeleted(id);
      // Mirrors incremental.ts's live-path pairing of delete + stale-mark.
      await markEdgesStaleForNode(id);
      return;
    }
    case "RelationAdded": {
      const { edge } = event.payload as { edge: Parameters<typeof upsertEdgeByTriple>[0] };
      await upsertEdgeByTriple(edge);
      return;
    }
    case "RelationInvalidated": {
      const { edgeId } = event.payload as { edgeId: string };
      await markEdgeInvalid(edgeId);
      return;
    }
    case "ExperienceRecorded": {
      const { experience } = event.payload as { experience: Parameters<typeof recordExperience>[0] };
      await recordExperience(experience);
      return;
    }
    case "ExperiencePromoted":
    case "InvariantLearned":
    case "DecisionRecorded":
      return;
  }
}

/** Applies a batch of events in order. Callers own fetching the events (e.g. via `listEventsSince`). */
export async function replayEvents(events: MemoryEvent[]): Promise<void> {
  for (const event of events) {
    await applyEvent(event);
  }
}

/**
 * Empties the materialized tables WITHOUT touching `events` (the source of
 * truth this rebuilds from) or `schema_migrations`. `RESTART IDENTITY` on
 * `experiences`/`nodes`/`edges` is moot — both use text/hash ids, not
 * sequences — kept off deliberately since `events.id` (bigserial) must NOT
 * be touched by this at all and a blanket RESTART IDENTITY on unrelated
 * tables is one less thing to reason about being safe.
 */
export async function wipeMaterializedGraph(): Promise<void> {
  const pool = getPool();
  await pool.query(`TRUNCATE TABLE experiences, edges, nodes`);
}

/** Full rebuild: wipe the materialized graph, replay every event ever recorded. */
export async function rebuildFromEvents(): Promise<void> {
  await wipeMaterializedGraph();
  const events = await listEventsSince(0);
  await replayEvents(events);
}
