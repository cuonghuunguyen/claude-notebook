import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb, withTransaction } from "./db.js";

const dirName = dirname(fileURLToPath(import.meta.url));
// dist/migrate.js -> packages/graph-store/dist -> repo root -> migrations/
// The published CLI bundle ships its own copy and points here via the env var.
const migrationsDir =
  process.env["MEMORY_MIGRATIONS_DIR"] ?? join(dirName, "..", "..", "..", "migrations");

/**
 * The applied-check contract is unchanged (spec.md §25.5 decision 1): one row
 * per applied file, files applied in name order, each inside a transaction, and
 * re-running applies nothing.
 *
 * What is gone is the advisory lock the Postgres runner needed (§25.4).
 * `CREATE EXTENSION IF NOT EXISTS` and `CREATE TABLE IF NOT EXISTS` were not
 * atomic against a concurrent identical statement there — two vitest workers on
 * a fresh database raced and one lost on a catalog unique index — so a
 * session-level lock had to serialize the whole run. SQLite has one global
 * write lock: `BEGIN IMMEDIATE` takes it, a second process waits out its busy
 * timeout, and the loser then finds `schema_migrations` already populated. The
 * behaviour every caller assumed is now the engine's default rather than
 * something this file arranges.
 */
export async function runMigrations(): Promise<{ applied: string[] }> {
  const db = getDb();
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);

  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  const { rows } = await db.query<{ id: string }>("SELECT id FROM schema_migrations");
  const applied = new Set(rows.map((row) => row.id));
  const newlyApplied: string[] = [];

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), "utf-8");
    try {
      await withTransaction(async (tx) => {
        // Multi-statement DDL: `execute` rather than `query`, because a
        // prepared statement holds exactly one statement.
        getDb().execute(sql);
        await tx.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file]);
      });
      newlyApplied.push(file);
    } catch (err) {
      // The transaction already rolled back; this only renames the failure so a
      // caller learns WHICH file failed.
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    }
  }

  return { applied: newlyApplied };
}
