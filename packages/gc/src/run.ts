import { hardDeleteInvalidEdgesBefore, hardDeleteNodesDeletedBefore } from "@cognitive-memory/graph-store";
import { markPromotedExperiencesCold } from "./coldStorage.js";

/** spec.md §18: soft-deleted nodes are retained 90 days before hard-deletion. */
export const DELETED_NODE_RETENTION_DAYS = 90;
/** spec.md §18: invalidated edges are retained 30 days before hard-deletion — shorter than nodes', since an invalidated edge has no "this used to exist" retrieval value the way a deleted node does. */
export const INVALID_EDGE_RETENTION_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface GCResult {
  nodesHardDeleted: number;
  edgesHardDeleted: number;
  experiencesMarkedCold: number;
}

/**
 * spec.md §18's batch job. `now` defaults to the real clock but is
 * accepted as a parameter so tests can exercise the 90/30-day boundaries
 * without waiting real days — retention cutoffs are computed from it, not
 * from Postgres's `now()`, so a test's backdated `updated_at` fixtures and
 * this function's notion of "how long ago" agree.
 */
export async function runGC(now: Date = new Date()): Promise<GCResult> {
  const nodesCutoff = new Date(now.getTime() - DELETED_NODE_RETENTION_DAYS * MS_PER_DAY);
  const edgesCutoff = new Date(now.getTime() - INVALID_EDGE_RETENTION_DAYS * MS_PER_DAY);

  const nodesHardDeleted = await hardDeleteNodesDeletedBefore(nodesCutoff);
  const edgesHardDeleted = await hardDeleteInvalidEdgesBefore(edgesCutoff);
  const experiencesMarkedCold = await markPromotedExperiencesCold();

  return { nodesHardDeleted, edgesHardDeleted, experiencesMarkedCold };
}
