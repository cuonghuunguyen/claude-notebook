import type { Node, NodeStatus, NodeType, Provenance } from "@cognitive-memory/core";
import { getPool, type Queryable } from "./db.js";

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
 *
 * `repoId` is not part of the spec.md §3.1 Node type — it's already baked
 * into `node.id`'s hash — but is stored alongside it so path-scoped lookups
 * (getNodesByPath) don't collide across repos that happen to share a
 * relative file path.
 */
export async function upsertNode(node: Node, repoId: string, db: Queryable = getPool()): Promise<Node> {
  const { rows } = await db.query<NodeRow>(
    `
    INSERT INTO nodes (id, repo_id, type, name, path, summary, metadata, provenance, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (id) DO UPDATE SET
      repo_id = EXCLUDED.repo_id,
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
      repoId,
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

export async function getNodeById(id: string, db: Queryable = getPool()): Promise<Node | undefined> {
  const { rows } = await db.query<NodeRow>(
    `SELECT ${NODE_COLUMNS} FROM nodes WHERE id = $1`,
    [id]
  );
  const row = rows[0];
  return row ? rowToNode(row) : undefined;
}

/**
 * Batch node fetch by id, used by traversal (M5) to hydrate a whole
 * frontier's neighbor nodes in one round trip instead of N `getNodeById`
 * calls — the same batching principle spec.md §10/§16 apply to the
 * reasoning call and the frontier query applies here too. `deleted` nodes
 * are excluded: a frontier edge pointing at a node deleted since the edge
 * was last touched shouldn't be offered to the reasoner as a candidate.
 */
export async function getNodesByIds(
  ids: string[],
  options: { includeDeleted?: boolean; db?: Queryable } = {}
): Promise<Node[]> {
  if (ids.length === 0) return [];
  const db = options.db ?? getPool();
  const { rows } = await db.query<NodeRow>(
    `SELECT ${NODE_COLUMNS} FROM nodes WHERE id = ANY($1) ${options.includeDeleted ? "" : "AND status != 'deleted'"}`,
    [ids]
  );
  return rows.map(rowToNode);
}

/**
 * Soft-delete: status -> "deleted". Row (and its edges) is retained for the
 * 90-day window from spec.md §18 GC policy; a batch job hard-deletes later.
 */
export async function markNodeDeleted(id: string, db: Queryable = getPool()): Promise<void> {
  await db.query(
    `UPDATE nodes SET status = 'deleted', updated_at = now() WHERE id = $1`,
    [id]
  );
}

/**
 * spec.md §18 GC batch job: nodes soft-deleted more than 90 days ago are
 * hard-deleted. `edges` cascades via `ON DELETE CASCADE` (migrations/
 * 0001_init.sql) — no separate edge cleanup needed here. `cutoff` is passed
 * in rather than computed as `now() - interval '90 days'` so tests can
 * exercise the boundary without waiting 90 real days.
 */
export async function hardDeleteNodesDeletedBefore(cutoff: Date): Promise<number> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM nodes WHERE status = 'deleted' AND updated_at < $1`,
    [cutoff]
  );
  return rowCount ?? 0;
}

/** Used by incremental structural extraction (M1) to find what a changed file previously produced. */
export async function getNodesByPath(repoId: string, path: string): Promise<Node[]> {
  const pool = getPool();
  const { rows } = await pool.query<NodeRow>(
    `SELECT ${NODE_COLUMNS} FROM nodes WHERE repo_id = $1 AND path = $2 AND status != 'deleted'`,
    [repoId, path]
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

/** pgvector expects `'[0.1,0.2,...]'` text input, not a JS array — `pg` has no native vector type support. */
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

/**
 * Writes the embedding used by the vector leg of hybrid retrieval (spec.md
 * §9). Separate from `upsertNode` because embedding computation is the
 * caller's responsibility (packages/retrieval, via an injected provider) —
 * this function only persists a vector someone else already computed.
 */
export async function upsertNodeEmbedding(id: string, embedding: number[]): Promise<void> {
  const pool = getPool();
  await pool.query(`UPDATE nodes SET embedding = $2, updated_at = now() WHERE id = $1`, [
    id,
    toVectorLiteral(embedding),
  ]);
}

export interface NodeSearchHit {
  node: Node;
  score: number;
}

/**
 * Lexical leg of hybrid retrieval (spec.md §9): `pg_trgm` trigram similarity
 * over name/path, not `tsvector` — degrades gracefully on partial/typo'd
 * identifiers the way full-text search does not.
 *
 * The WHERE filter uses the `%` operator (not `similarity(...) >= threshold`)
 * specifically because `%` is the operator `nodes_name_trgm_idx`/
 * `nodes_path_trgm_idx`'s GIN indexes support — `similarity()` used as a
 * plain boolean comparison is not indexable at all and forces a full table
 * scan regardless of planner settings (verified via `EXPLAIN ANALYZE` with
 * `enable_seqscan=off`: the `similarity() >= x` shape has no alternative
 * plan, while `%` produces a `BitmapOr` over both trgm indexes). `%`'s
 * threshold is controlled by the session-scoped `pg_trgm.similarity_limit`
 * GUC (via `set_limit()`), so it's set on the same client that runs the
 * search — a pooled connection must not carry a stale threshold into
 * whichever query borrows it next.
 *
 * `repoId`, like `getNodesByPath`'s, is an optional scope: a retrieval
 * session operates against one repo's graph at a time, and without this a
 * fixture/eval node can't be distinguished from same-named nodes another
 * repo (or another test run sharing the same Postgres instance) inserted.
 */
export async function searchNodesByTrigram(
  query: string,
  limit = 10,
  threshold = 0.1,
  repoId?: string
): Promise<NodeSearchHit[]> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("SELECT set_limit($1)", [threshold]);
    const { rows } = await client.query<NodeRow & { score: number }>(
      `
      SELECT ${NODE_COLUMNS},
        GREATEST(similarity(coalesce(name, ''), $1), similarity(coalesce(path, ''), $1)) AS score
      FROM nodes
      WHERE status != 'deleted'
        AND (name % $1 OR path % $1)
        AND ($3::text IS NULL OR repo_id = $3)
      ORDER BY score DESC
      LIMIT $2
      `,
      [query, limit, repoId ?? null]
    );
    return rows.map((row) => ({ node: rowToNode(row), score: row.score }));
  } finally {
    client.release();
  }
}

/**
 * Vector leg of hybrid retrieval (spec.md §9). `<=>` is pgvector's cosine
 * distance operator (paired with the `vector_cosine_ops` HNSW index in
 * migrations/0001_init.sql) — similarity is `1 - distance`. `repoId` scopes
 * the same way as `searchNodesByTrigram`.
 */
export async function searchNodesByEmbedding(
  embedding: number[],
  limit = 10,
  repoId?: string
): Promise<NodeSearchHit[]> {
  const pool = getPool();
  const { rows } = await pool.query<NodeRow & { score: number }>(
    `
    SELECT ${NODE_COLUMNS}, 1 - (embedding <=> $1) AS score
    FROM nodes
    WHERE status != 'deleted' AND embedding IS NOT NULL
      AND ($3::text IS NULL OR repo_id = $3)
    ORDER BY embedding <=> $1
    LIMIT $2
    `,
    [toVectorLiteral(embedding), limit, repoId ?? null]
  );
  return rows.map((row) => ({ node: rowToNode(row), score: row.score }));
}
