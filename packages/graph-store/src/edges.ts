import type { Edge, EdgeStatus, Provenance, RelationType } from "@cognitive-memory/core";
import { getPool, type Queryable } from "./db.js";

interface EdgeRow {
  id: string;
  from_id: string;
  to_id: string;
  relation: string;
  confidence: number;
  weight: number;
  provenance: Provenance[];
  status: EdgeStatus;
  created_at: Date;
  updated_at: Date;
  last_verified_at: Date | null;
}

function rowToEdge(row: EdgeRow): Edge {
  return {
    id: row.id,
    from: row.from_id,
    to: row.to_id,
    relation: row.relation as RelationType,
    confidence: row.confidence,
    weight: row.weight,
    provenance: row.provenance,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lastVerifiedAt: row.last_verified_at?.toISOString(),
  };
}

const EDGE_COLUMNS = `id, from_id, to_id, relation, confidence, weight, provenance, status, created_at, updated_at, last_verified_at`;

/**
 * Insert an edge, or if one already exists for this (from, to, relation)
 * triple, APPEND the new provenance to the existing array rather than
 * creating a duplicate row — spec.md §3.3/§13: conflicting facts about the
 * same triple live as multiple provenance entries on one edge, surfaced
 * together when status is "disputed".
 *
 * Confidence/weight/status recomputation from the merged provenance list is
 * the caller's responsibility (packages/semantic, M3) — this function only
 * persists whatever the caller already decided, including `lastVerifiedAt`
 * (spec.md §7's durable-via-verification path / §12's lazy re-verification).
 *
 * `db` defaults to the shared pool but accepts a checked-out `PoolClient` so
 * a caller running this inside its own transaction (e.g. an advisory-lock-
 * guarded read-modify-write) doesn't borrow a second pool connection for it.
 */
export async function upsertEdgeByTriple(edge: Edge, db: Queryable = getPool()): Promise<Edge> {
  const { rows } = await db.query<EdgeRow>(
    `
    INSERT INTO edges (id, from_id, to_id, relation, confidence, weight, provenance, status, last_verified_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (from_id, to_id, relation) DO UPDATE SET
      confidence = EXCLUDED.confidence,
      weight = EXCLUDED.weight,
      provenance = EXCLUDED.provenance,
      status = EXCLUDED.status,
      last_verified_at = EXCLUDED.last_verified_at,
      updated_at = now()
    RETURNING ${EDGE_COLUMNS}
    `,
    [
      edge.id,
      edge.from,
      edge.to,
      edge.relation,
      edge.confidence,
      edge.weight,
      JSON.stringify(edge.provenance),
      edge.status,
      edge.lastVerifiedAt ?? null,
    ]
  );
  const row = rows[0];
  if (!row) throw new Error(`upsertEdgeByTriple: no row returned for ${edge.id}`);
  return rowToEdge(row);
}

/**
 * Fetches the single edge for a (from, to, relation) triple, if one exists.
 * Callers merging a new observation into an existing fact's provenance
 * (packages/semantic, M3) need this to read the current provenance array
 * before appending — `upsertEdgeByTriple` only persists what it's given, it
 * doesn't read-then-merge itself. `db` — see `upsertEdgeByTriple`'s note.
 */
export async function getEdgeByTriple(
  from: string,
  to: string,
  relation: RelationType,
  db: Queryable = getPool()
): Promise<Edge | undefined> {
  const { rows } = await db.query<EdgeRow>(
    `SELECT ${EDGE_COLUMNS} FROM edges WHERE from_id = $1 AND to_id = $2 AND relation = $3`,
    [from, to, relation]
  );
  const row = rows[0];
  return row ? rowToEdge(row) : undefined;
}

export async function getEdgesFrom(fromId: string): Promise<Edge[]> {
  const pool = getPool();
  const { rows } = await pool.query<EdgeRow>(
    `SELECT ${EDGE_COLUMNS} FROM edges WHERE from_id = $1`,
    [fromId]
  );
  return rows.map(rowToEdge);
}

export async function getEdgesTouchingNode(nodeId: string): Promise<Edge[]> {
  const pool = getPool();
  const { rows } = await pool.query<EdgeRow>(
    `SELECT ${EDGE_COLUMNS} FROM edges WHERE from_id = $1 OR to_id = $1`,
    [nodeId]
  );
  return rows.map(rowToEdge);
}

/**
 * Edges touching `nodeId` whose relation is one of `relations`, highest
 * `weight` first. Used by seed expansion (spec.md §9): 1-hop structural
 * neighbors of top search hits, and highest-weight semantic neighbors of a
 * matched concept/invariant node — same query shape, different relation set.
 */
export async function getNeighborEdgesByRelation(
  nodeId: string,
  relations: readonly RelationType[],
  limit = 10
): Promise<Edge[]> {
  if (relations.length === 0) return [];
  const pool = getPool();
  const { rows } = await pool.query<EdgeRow>(
    `SELECT ${EDGE_COLUMNS} FROM edges
     WHERE (from_id = $1 OR to_id = $1) AND relation = ANY($2) AND status = 'active'
     ORDER BY weight DESC
     LIMIT $3`,
    [nodeId, relations, limit]
  );
  return rows.map(rowToEdge);
}

export interface FrontierEdge {
  edge: Edge;
  /** The endpoint of `edge` that is NOT in the queried node set — the candidate neighbor. */
  neighborId: string;
}

/**
 * One frontier's worth of active edges touching `nodeIds`, for reasoning-
 * guided traversal (spec.md §10, §16): "the traversal loop fetches one full
 * frontier per depth level via a single CTE query... not one query per
 * neighbor." `excludeNeighborIds` (the full visited set, a superset of
 * `nodeIds`) filters out edges whose neighbor has already been visited —
 * both to avoid re-offering an already-included node as a "new" candidate
 * and to drop edges that are entirely internal to the visited region (both
 * endpoints already visited, so neither side is a fresh neighbor).
 *
 * `limit` is a safety cap on rows fetched from Postgres, not the final
 * frontier size handed to the reasoning call — traversal (M5) ranks this
 * raw set by spec.md §11's formula and caps it further (e.g. top 15) before
 * it reaches the reasoner. Ordered by `weight DESC` here only so a query
 * that hits the safety cap keeps the highest-weight rows rather than an
 * arbitrary prefix.
 */
export async function getFrontierEdges(
  nodeIds: string[],
  excludeNeighborIds: string[],
  limit = 500
): Promise<FrontierEdge[]> {
  if (nodeIds.length === 0) return [];
  const pool = getPool();
  const { rows } = await pool.query<EdgeRow & { neighbor_id: string }>(
    `
    WITH frontier AS (
      SELECT id, from_id, to_id, relation, confidence, weight, provenance, status,
             created_at, updated_at, last_verified_at,
             CASE WHEN from_id = ANY($1) THEN to_id ELSE from_id END AS neighbor_id
      FROM edges
      WHERE (from_id = ANY($1) OR to_id = ANY($1)) AND status = 'active'
    )
    SELECT ${EDGE_COLUMNS}, neighbor_id
    FROM frontier
    WHERE neighbor_id != ALL($2)
    ORDER BY weight DESC
    LIMIT $3
    `,
    [nodeIds, excludeNeighborIds, limit]
  );
  return rows.map((row) => ({ edge: rowToEdge(row), neighborId: row.neighbor_id }));
}

/**
 * spec.md §5 step 6 / §12: when a structural node changes, edges touching
 * it that aren't plain structural facts need re-verification before being
 * trusted again.
 */
export async function markEdgesStaleForNode(nodeId: string): Promise<number> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE edges SET status = 'stale', updated_at = now()
     WHERE (from_id = $1 OR to_id = $1) AND status = 'active'`,
    [nodeId]
  );
  return rowCount ?? 0;
}
