/**
 * The one place this system talks to a database (spec.md §25).
 *
 * SQLite is the only backend. There is no storage seam here and no second
 * implementation to swap in: §25.2 rejected a dual-backend abstraction because
 * it would double every query site and the integration matrix permanently to
 * serve a networked deployment that does not exist. What this module provides
 * is a driver, not a portability layer — the SQL below it is SQLite SQL.
 *
 * ## Why the call shape is still `query(sql, params)` returning `{ rows }`
 *
 * `better-sqlite3` is synchronous and statement-oriented. Exposing it directly
 * would have meant rewriting the control flow of every caller as well as its
 * SQL, and a port that changes both cannot be measured — spec.md §25.5's gate
 * (retrieval quality must not move) only means something if the diff is
 * confined to the SQL. So the shape callers already use is kept, with `$1`
 * placeholders translated to `?` positionally. The `Promise` is genuinely
 * unnecessary at runtime and genuinely load-bearing for the port: it keeps
 * every `await` in every caller correct without touching it.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

export interface QueryResult<T> {
  rows: T[];
  /** Rows returned for a SELECT / RETURNING statement, rows changed otherwise. */
  rowCount: number;
}

/**
 * Anything statements can be run on. Since there is exactly one connection,
 * every `Queryable` in this process is the same connection — which is what
 * makes "join the caller's transaction" free rather than something a pool has
 * to be talked out of.
 */
export interface Queryable {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[]
  ): Promise<QueryResult<T>>;
}

/**
 * Brand marking a `Queryable` that is known to be inside an open transaction.
 *
 * Under Postgres this distinction existed because `Queryable` was satisfied by
 * the pool, and passing the pool to a parameter whose whole purpose was
 * atomicity silently meant "no BEGIN, statements on whichever connections are
 * free". SQLite has one connection, so that particular footgun is gone — but
 * the weaker one it protected against is not: passing the shared handle to a
 * parameter that documents "this write must land with mine" is still a caller
 * writing outside the transaction it thinks it is in. Only `withTransaction`
 * can mint a branded handle, so the type keeps saying what it said.
 */
export const TRANSACTION: unique symbol = Symbol("cognitive-memory.transaction");

export interface TransactionClient extends Queryable {
  readonly [TRANSACTION]: true;
}

const dirName = dirname(fileURLToPath(import.meta.url));
// dist/db.js -> packages/graph-store/dist -> packages/graph-store -> packages -> repo root
const repoRoot = join(dirName, "..", "..", "..");

/**
 * Where the memory lives when nothing says otherwise.
 *
 * Repo-root-relative rather than cwd-relative on purpose: every package runs
 * its own tests from its own directory and `scripts/self-memory.mjs` runs from
 * the root, and a cwd-relative default would silently give them different
 * databases. `MEMORY_DB` overrides it (tests point it at a temp file); no
 * environment variable is needed to run, which is the adoption cost §25.1
 * measured.
 */
export function defaultDatabasePath(): string {
  return process.env["MEMORY_DB"] ?? join(repoRoot, ".claude", "memory.db");
}

export interface SqliteDb extends Queryable {
  /** Multi-statement DDL (migration files). No parameters, no result. */
  execute(sql: string): void;
  readonly path: string;
}

let handle: Database.Database | undefined;
let db: SqliteDb | undefined;

/** Rejects anything SQLite cannot bind, instead of stringifying it by accident. */
function coerce(value: unknown): null | number | bigint | string | Buffer | Uint8Array {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "string") {
    return value;
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value;
  // Arrays and plain objects are the dangerous case: Postgres took `text[]` and
  // `jsonb[]` parameters directly, and SQLite has neither. Every such site was
  // rewritten to pass a JSON *string* consumed by `json_each` (spec.md §25.5),
  // so an array arriving here means a site was missed — which must fail loudly
  // rather than bind "[object Object]" and match nothing.
  throw new TypeError(
    `cannot bind ${Array.isArray(value) ? "an array" : typeof value} as a SQL parameter; ` +
      `pass JSON text and consume it with json_each (spec.md §25.5)`
  );
}

/**
 * `$1`-style placeholders to `?`, duplicating parameters that appear twice.
 *
 * Postgres placeholders are numbered and reusable; SQLite's `?` are positional.
 * Several queries here reference the same parameter twice (the anchor lookup's
 * two `EXISTS` legs, the visibility predicate's flags), so the translation has
 * to emit one bound value per *occurrence*, not per parameter.
 *
 * ## Why it skips string literals and comments instead of a plain replace
 *
 * Today no query in this package contains a `$` followed by a digit anywhere
 * except a placeholder — the JSON paths are `'$.path'`, `'$.id'`, `'$.tier'`,
 * `'$.reason'`, `'$.watermark'`, all `$` followed by `.`. A regex replace over
 * the whole string is therefore correct *right now*, and that is exactly the
 * problem: this is the single chokepoint every one of the ported query sites
 * passes through, and the day someone writes `json_extract(value, '$[1]')` or a
 * comment mentioning `$1`, a blind replace would silently rewrite it into a
 * bound parameter and shift every argument after it by one. The failure would
 * not be a syntax error, it would be a query matching the wrong rows.
 *
 * So the scan tracks the three places a `$` cannot be a placeholder: inside a
 * single-quoted literal (with `''` as the escape), inside a `"`-quoted
 * identifier (`"timestamp"` is one), and inside a `--` or a block comment. The
 * SQL here has no dollar-quoting to worry about — that was plpgsql, and
 * spec.md §25.5 replaced migration 0007's `DO $$ ... $$` with plain DDL.
 */
function toPositional(
  sql: string,
  params: readonly unknown[]
): { text: string; values: ReturnType<typeof coerce>[] } {
  const values: ReturnType<typeof coerce>[] = [];
  let text = "";
  let index = 0;

  while (index < sql.length) {
    const char = sql[index] as string;

    if (char === "'" || char === '"') {
      // A quoted literal or identifier: copy verbatim to the closing quote,
      // treating a doubled quote as an escape rather than as the end.
      const quote = char;
      let end = index + 1;
      while (end < sql.length) {
        if (sql[end] === quote) {
          if (sql[end + 1] === quote) end += 2;
          else break;
        } else end += 1;
      }
      text += sql.slice(index, Math.min(end + 1, sql.length));
      index = end + 1;
      continue;
    }

    if (char === "-" && sql[index + 1] === "-") {
      const newline = sql.indexOf("\n", index);
      const end = newline === -1 ? sql.length : newline;
      text += sql.slice(index, end);
      index = end;
      continue;
    }

    if (char === "/" && sql[index + 1] === "*") {
      const close = sql.indexOf("*/", index + 2);
      const end = close === -1 ? sql.length : close + 2;
      text += sql.slice(index, end);
      index = end;
      continue;
    }

    if (char === "$") {
      let end = index + 1;
      while (end < sql.length && sql[end] !== undefined && /[0-9]/.test(sql[end] as string)) {
        end += 1;
      }
      if (end > index + 1) {
        const position = Number(sql.slice(index + 1, end)) - 1;
        if (position < 0 || position >= params.length) {
          throw new Error(
            `SQL references $${sql.slice(index + 1, end)} but only ${params.length} parameters were given`
          );
        }
        values.push(coerce(params[position]));
        text += "?";
        index = end;
        continue;
      }
    }

    text += char;
    index += 1;
  }

  return { text, values };
}

function open(path: string): Database.Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  // WAL so a reader never blocks on the writer — the replacement for what the
  // two `pg_advisory_lock` calls simulated (spec.md §25.4).
  sqlite.pragma("journal_mode = WAL");
  // Not the default in SQLite, and migration 0007's supersede link plus
  // 0005's (memory, session) join both depend on it being enforced.
  sqlite.pragma("foreign_keys = ON");
  // A second process (a test worker, a `self-memory.mjs` run) waits for the
  // write lock instead of failing with SQLITE_BUSY.
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("synchronous = NORMAL");
  return sqlite;
}

function wrap(sqlite: Database.Database, path: string): SqliteDb {
  return {
    path,
    execute(sql: string): void {
      sqlite.exec(sql);
    },
    async query<T>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
      const { text, values } = toPositional(sql, params);
      const statement = sqlite.prepare(text);
      if (statement.reader) {
        const rows = statement.all(...values) as T[];
        return { rows, rowCount: rows.length };
      }
      const info = statement.run(...values);
      return { rows: [], rowCount: info.changes };
    },
  };
}

export function getDb(options: { path?: string } = {}): SqliteDb {
  if (!db) {
    const path = options.path ?? defaultDatabasePath();
    handle = open(path);
    db = wrap(handle, path);
  }
  return db;
}

export function closeDb(): void {
  if (handle) {
    handle.close();
    handle = undefined;
    db = undefined;
  }
}

/**
 * Points the process at a different database file, closing the current one.
 *
 * Exists for tests and for the scout-report export/import (spec.md §25.5
 * decision 2), which is the one operation that legitimately touches two
 * databases in one run.
 */
export function useDatabase(path: string): SqliteDb {
  closeDb();
  return getDb({ path });
}

/**
 * Serializes transactions on the single connection.
 *
 * SQLite has one global write lock, so what `pg_advisory_lock` and
 * `FOR UPDATE` were simulating is the engine's default across *processes*
 * (spec.md §25.4). Inside one process it is not: two concurrent async
 * transactions sharing this connection would interleave their statements
 * between `BEGIN` and `COMMIT` and produce a nested-transaction error or,
 * worse, a commit of half of each. This queue is the in-process half of that
 * write lock, and it is what makes `supersedeExperience`'s check-then-write
 * atomic against a concurrent supersede — the property the advisory lock
 * existed for.
 *
 * `BEGIN IMMEDIATE` rather than a deferred `BEGIN`: the write lock is taken up
 * front, so a second *process* waits out its busy timeout at the start instead
 * of failing partway through with SQLITE_BUSY after having read.
 *
 * Nesting is refused rather than left to deadlock on the queue. A caller that
 * needs to join an open transaction takes the `TransactionClient` as a
 * parameter — the pattern `recordSupersedingExperience` uses.
 *
 * ## Exactly what the queue does and does not serialize
 *
 * It serializes *transactions against each other*. It does not, and cannot,
 * hold back a plain `getDb().query(...)` issued while a transaction is open:
 * there is one connection, so an untransacted write during someone else's
 * `BEGIN IMMEDIATE` lands *inside* that transaction and is rolled back with it.
 * Under Postgres the same call went out on a different pooled connection and
 * committed on its own. Nothing in this package writes that way today — every
 * multi-statement write either owns its transaction or takes a
 * `TransactionClient` — and the branded type is what keeps it that way, so this
 * is documented rather than architected around. A caller that genuinely needs a
 * write to be independent of an in-flight transaction has to be inside
 * `withTransaction` itself, i.e. queued.
 *
 * The database handle is captured when `withTransaction` is *called*, not when
 * the queue reaches it. Otherwise a transaction enqueued behind another and a
 * `closeDb()` in between would resolve `getDb()` fresh and silently reopen
 * `defaultDatabasePath()` — committing a test's or a harness's writes into the
 * repo's real memory file. Holding the handle makes that case throw on a closed
 * connection instead.
 */
const txContext = new AsyncLocalStorage<true>();
let queue: Promise<unknown> = Promise.resolve();

export async function withTransaction<T>(
  run: (db: TransactionClient) => Promise<T>
): Promise<T> {
  if (txContext.getStore()) {
    throw new Error(
      "withTransaction cannot be nested — pass the TransactionClient down instead"
    );
  }
  const sqlite = getDb();
  const attempt = queue.then(() =>
    txContext.run(true, async () => {
      const client = { ...sqlite, [TRANSACTION]: true } as TransactionClient;
      await sqlite.query("BEGIN IMMEDIATE");
      try {
        const result = await run(client);
        await sqlite.query("COMMIT");
        return result;
      } catch (err) {
        await sqlite.query("ROLLBACK").catch(() => {});
        throw err;
      }
    })
  );
  // The queue must survive a rejected transaction, or one failure would reject
  // every transaction queued behind it.
  queue = attempt.catch(() => undefined);
  return attempt;
}
