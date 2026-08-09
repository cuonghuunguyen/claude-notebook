import { Pool, type PoolConfig } from "pg";

let pool: Pool | undefined;

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
