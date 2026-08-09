import type { Edge, EdgeStatus, Provenance, RelationType } from "@cognitive-memory/core";
import { getPool } from "./db.js";

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
 * persists whatever the caller already decided.
 */
export async function upsertEdgeByTriple(edge: Edge): Promise<Edge> {
  const pool = getPool();
  const { rows } = await pool.query<EdgeRow>(
    `
    INSERT INTO edges (id, from_id, to_id, relation, confidence, weight, provenance, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (from_id, to_id, relation) DO UPDATE SET
      confidence = EXCLUDED.confidence,
      weight = EXCLUDED.weight,
      provenance = EXCLUDED.provenance,
      status = EXCLUDED.status,
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
    ]
  );
  const row = rows[0];
  if (!row) throw new Error(`upsertEdgeByTriple: no row returned for ${edge.id}`);
  return rowToEdge(row);
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
