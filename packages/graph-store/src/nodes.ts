import type { Node, NodeStatus, NodeType, Provenance } from "@cognitive-memory/core";
import { getPool } from "./db.js";

interface NodeRow {
  id: string;
  type: string;
  name: string | null;
  path: string | null;
  summary: string | null;
  metadata: Node["metadata"];
  provenance: Provenance[];
  status: NodeStatus;
  created_at: Date;
  updated_at: Date;
}

function rowToNode(row: NodeRow): Node {
  return {
    id: row.id,
    type: row.type as NodeType,
    name: row.name ?? undefined,
    path: row.path ?? undefined,
    summary: row.summary ?? undefined,
    metadata: row.metadata,
    provenance: row.provenance,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const NODE_COLUMNS = `id, type, name, path, summary, metadata, provenance, status, created_at, updated_at`;

/**
 * Insert a node, or update it in place if the id already exists — per
 * spec.md §3.2, a resolved rename updates the existing row rather than
 * creating a new one. embedding is intentionally omitted here; retrieval
 * (M2) writes it separately once an embedding provider is wired up.
 */
export async function upsertNode(node: Node): Promise<Node> {
  const pool = getPool();
  const { rows } = await pool.query<NodeRow>(
    `
    INSERT INTO nodes (id, type, name, path, summary, metadata, provenance, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (id) DO UPDATE SET
      type = EXCLUDED.type,
      name = EXCLUDED.name,
      path = EXCLUDED.path,
      summary = EXCLUDED.summary,
      metadata = EXCLUDED.metadata,
      provenance = EXCLUDED.provenance,
      status = EXCLUDED.status,
      updated_at = now()
    RETURNING ${NODE_COLUMNS}
    `,
    [
      node.id,
      node.type,
      node.name ?? null,
      node.path ?? null,
      node.summary ?? null,
      JSON.stringify(node.metadata),
      JSON.stringify(node.provenance),
      node.status,
    ]
  );
  const row = rows[0];
  if (!row) throw new Error(`upsertNode: no row returned for id ${node.id}`);
  return rowToNode(row);
}

export async function getNodeById(id: string): Promise<Node | undefined> {
  const pool = getPool();
  const { rows } = await pool.query<NodeRow>(
    `SELECT ${NODE_COLUMNS} FROM nodes WHERE id = $1`,
    [id]
  );
  const row = rows[0];
  return row ? rowToNode(row) : undefined;
}

/**
 * Soft-delete: status -> "deleted". Row (and its edges) is retained for the
 * 90-day window from spec.md §18 GC policy; a batch job hard-deletes later.
 */
export async function markNodeDeleted(id: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE nodes SET status = 'deleted', updated_at = now() WHERE id = $1`,
    [id]
  );
}

/** Used by incremental structural extraction (M1) to find what a changed file previously produced. */
export async function getNodesByPath(path: string): Promise<Node[]> {
  const pool = getPool();
  const { rows } = await pool.query<NodeRow>(
    `SELECT ${NODE_COLUMNS} FROM nodes WHERE path = $1 AND status != 'deleted'`,
    [path]
  );
  return rows.map(rowToNode);
}

export async function listNodesByType(type: NodeType): Promise<Node[]> {
  const pool = getPool();
  const { rows } = await pool.query<NodeRow>(
    `SELECT ${NODE_COLUMNS} FROM nodes WHERE type = $1 ORDER BY updated_at DESC`,
    [type]
  );
  return rows.map(rowToNode);
}
