/**
 * Test- and harness-database setup, exported because every package's
 * integration suite needs it (spec.md §25.4's last bullet) and because the eval
 * harnesses need the same guarantee by a different route.
 *
 * Under Postgres, integration tests self-skipped when `DATABASE_URL` was unset
 * and shared one database when it was. Both halves of that are gone: after the
 * port there is nothing to skip on — a SQLite file always exists — and
 * ROADMAP.md M17's acceptance is explicit that no test may skip for a missing
 * connection string. So the shape has to change from "skip unless configured"
 * to "each suite gets its own database".
 *
 * Per suite, not per process, and that is the load-bearing detail. vitest runs a
 * package's test files in parallel workers and reuses a worker for several
 * files; a database chosen from an environment variable would therefore be
 * shared by whichever files happened to land in the same worker. That is exactly
 * the failure `packages/graph-store/vitest.config.ts` had to set
 * `fileParallelism: false` for — `integration.test.ts`'s rebuild-from-events
 * case wipes the whole database, and it was landing in the middle of a sibling
 * suite's fixtures. Calling this in `beforeAll` closes whatever database the
 * worker had open and opens a fresh one, so the isolation is a property of the
 * setup rather than of the runner's scheduling.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, useDatabase } from "./db.js";
import { runMigrations } from "./migrate.js";

const created: string[] = [];
let cleanupRegistered = false;

/**
 * A migrated, empty database of this suite's own, in a temp directory. Returns
 * its path.
 *
 * A real file rather than `:memory:` so that a test which needs a genuinely
 * second connection — the concurrent-supersede case — can open one, and so the
 * WAL and `busy_timeout` configuration under test is the configuration that
 * ships.
 *
 * The directory is removed when the worker process exits rather than by an
 * `afterAll` the caller has to remember: a suite that throws in `beforeAll`
 * would skip its own cleanup, and a leaked WAL-plus-sidecars directory per
 * failed run is exactly the kind of debris that accumulates unnoticed.
 */
export async function useTemporaryDatabase(name = "cognitive-memory"): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  created.push(dir);
  if (!cleanupRegistered) {
    cleanupRegistered = true;
    process.on("exit", () => {
      closeDb();
      for (const path of created) rmSync(path, { recursive: true, force: true });
    });
  }
  const path = join(dir, "memory.db");
  useDatabase(path);
  await runMigrations();
  return path;
}

/**
 * The database an eval harness or a one-off script runs against: declared by
 * `MEMORY_DB`, opened, and migrated. Returns its path.
 *
 * Two failures, one helper, because both are failures of *defaulting*.
 *
 * `defaultDatabasePath()` needing no configuration is the adoption cost §25.1
 * set out to remove, and for the product that is right. For a harness it is a
 * loaded gun: `eval/why-spike`'s capture mines 142 memories out of a *foreign*
 * repository, and `eval/tier-promotion`'s report mutates `access_count`,
 * `last_accessed`, `experience_accesses` and `tier` on whatever corpus it finds.
 * Defaulting means both land in this repo's dogfooded `.claude/memory.db`, with
 * no un-mine and no way to tell the foreign memories back out afterwards. Under
 * Postgres the `DATABASE_URL` requirement made that impossible by accident —
 * there was no default to fall into. The port removed the variable, so the
 * requirement has to be stated instead of inherited.
 *
 * And the migration, because `getDb()` creates the file on open: without this a
 * harness pointed at a fresh path fails with `no such table: experiences`, which
 * is what the reproduce command in `BENCHMARKS.md` does on a clean machine. It
 * reads as "the port is broken" rather than "nothing has migrated this file
 * yet". `runMigrations` is idempotent, so a harness that runs capture then probe
 * as two processes migrates twice and pays ~1 ms for it.
 *
 * Suites use `useTemporaryDatabase` instead; a harness cannot, because its
 * corpus has to survive the process — capture and probe are separate runs.
 */
export async function useScratchDatabase(harness: string): Promise<string> {
  const configured = process.env["MEMORY_DB"];
  if (!configured) {
    const example = harness.replace(/[^a-zA-Z0-9]+/g, "-");
    throw new Error(
      `${harness} needs MEMORY_DB pointing at a scratch database, e.g. ` +
        `MEMORY_DB=/tmp/${example}.db. It is required rather than defaulted because ` +
        `the default is this repo's own dogfooded memory (.claude/memory.db), and a ` +
        `harness writes a foreign corpus and mutates tier/access state in it.`
    );
  }
  useDatabase(configured);
  await runMigrations();
  return configured;
}
