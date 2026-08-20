import { Pool, type PoolClient, type PoolConfig } from "pg";

let pool: Pool | undefined;

/**
 * A pool or a single checked-out client — both expose the same `.query()`
 * shape. Functions that accept this instead of hardcoding `getPool()` can
 * run inside a caller-managed transaction (e.g. packages/semantic's
 * advisory-lock-guarded read-modify-write) without borrowing a second
 * connection from the pool for every statement, which risks a deadlock if
 * concurrent callers collectively hold all pool connections while each
 * waits on a lock only a query on a now-unobtainable connection can release.
 */
export type Queryable = Pool | PoolClient;

/**
 * A checked-out client specifically — NOT the pool.
 *
 * Used by the parameters whose whole purpose is to join a caller's
 * transaction. `Queryable` is wrong there: it is satisfied by `Pool`, and a
 * `Pool` silently turns the join into "run these statements on whatever
 * connections happen to be free", i.e. no `BEGIN`, row locks released
 * immediately, and the check and the write potentially on different
 * connections. That is precisely the atomicity those parameters exist to
 * provide, so the type rules it out rather than documenting against it.
 */
export type TransactionClient = PoolClient;

function connectionStringFromEnv(): string {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. graph-store needs a Postgres connection string, e.g. " +
        "postgres://postgres:postgres@localhost:5432/cognitive_memory"
    );
  }
  return url;
}

export function getPool(config?: PoolConfig): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: config?.connectionString ?? connectionStringFromEnv(),
      ...config,
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
