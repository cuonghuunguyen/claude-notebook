-- Text anchors + commit-triggered staleness (spec.md §24.2.2-§24.2.3 /
-- ROADMAP.md M12).
--
-- Until now a memory's only binding to the codebase was `related_nodes`, a
-- jsonb array holding a mix of structural node ids (written by the structural
-- graph) and plain paths (written by M11's capture). That worked, but it cannot
-- express the `{ path, symbol }` pair §24.2.2 decides on, and it gives the
-- staleness pass nothing to write its verdict to.
--
-- Three columns, one index. `anchors` is typed and queryable; `suspect` /
-- `suspect_reason` hold the sync-time verdict so it survives across sessions
-- instead of being recomputed by every reader.
--
-- `related_nodes` is deliberately NOT dropped or backfilled. The structural
-- graph lives until M15 and still writes node ids there, and a backfill would
-- have to guess which entries are paths — a guess the read path makes
-- explicitly and reversibly instead (`anchorsFromRelatedNodes`). Retiring the
-- column is M15's job, which is where the spec already puts it.
--
-- Re-runnable on its own (every statement is IF NOT EXISTS / ADD COLUMN IF NOT
-- EXISTS) on top of the migration runner's applied-check, so `runMigrations()`
-- twice and this file twice are both no-ops.

ALTER TABLE experiences ADD COLUMN IF NOT EXISTS anchors jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Commit-triggered staleness (§24.2.3). `false` rather than nullable-unknown:
-- a memory nothing has invalidated is trusted, and a nullable tri-state would
-- make every reader handle a third case that has no meaning here.
ALTER TABLE experiences ADD COLUMN IF NOT EXISTS suspect boolean NOT NULL DEFAULT false;
ALTER TABLE experiences ADD COLUMN IF NOT EXISTS suspect_reason text;

-- GIN over `anchors` so "which memories are anchored to these changed paths"
-- is an index scan, not a full-table scan of every memory ever recorded.
--
-- The query shape it serves is jsonb containment: `anchors @> '[{"path": "x"}]'`.
-- Containment is subset-based per object, so that predicate matches
-- `{"path": "x", "symbol": "y"}` too — a path-level trigger finds
-- symbol-qualified anchors on that path without needing a second index or a
-- separate query. This is the reason anchors are stored as objects in one jsonb
-- array rather than split across two columns.
CREATE INDEX IF NOT EXISTS experiences_anchors_idx ON experiences USING gin (anchors);
