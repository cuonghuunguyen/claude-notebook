import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool } from "./db.js";

const dirName = dirname(fileURLToPath(import.meta.url));
// dist/migrate.js -> packages/graph-store/dist -> repo root -> migrations/
const migrationsDir = join(dirName, "..", "..", "..", "migrations");

async function ensureMigrationsTable(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

/**
 * Arbitrary but fixed 64-bit key for the migration advisory lock. Any two
 * processes/workers using this module agree on it, which is the whole point.
 */
const MIGRATION_LOCK_KEY = 4_812_003_117_260_001n;

/**
 * Serializes the whole migrate run across connections.
 *
 * `CREATE EXTENSION IF NOT EXISTS` and `CREATE TABLE` are not safe against a
 * concurrent identical statement — the IF NOT EXISTS check and the catalog
 * insert are not atomic with respect to each other, so two callers that pass
 * the check together race and one gets `duplicate key value violates unique
 * constraint "pg_extension_name_index"`. Vitest runs a package's test files in
 * parallel workers, and every integration suite calls `runMigrations()` in its
 * own `beforeAll`, so as soon as a package has two suites this is reachable on
 * any fresh database. A session-level advisory lock makes the loser wait and
 * then find the work already done, which is the behaviour every caller already
 * assumed.
 */
export async function runMigrations(): Promise<{ applied: string[] }> {
  const client = await getPool().connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY.toString()]);
    return await applyPendingMigrations();
  } finally {
    // Best effort: if the unlock fails the connection is being discarded
    // anyway, and a session-level lock dies with its session.
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY.toString()]).catch(() => {});
    client.release();
  }
}

async function applyPendingMigrations(): Promise<{ applied: string[] }> {
  await ensureMigrationsTable();
  const pool = getPool();

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM schema_migrations"
  );
  const applied = new Set(rows.map((r) => r.id));
  const newlyApplied: string[] = [];

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), "utf-8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [
        file,
      ]);
      await client.query("COMMIT");
      newlyApplied.push(file);
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }

  return { applied: newlyApplied };
}

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  runMigrations()
    .then(({ applied }) => {
      if (applied.length === 0) {
        console.log("No new migrations to apply.");
      } else {
        console.log(`Applied: ${applied.join(", ")}`);
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
