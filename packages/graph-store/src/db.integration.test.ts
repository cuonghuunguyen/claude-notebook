import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getDb, withTransaction } from "./db.js";
import { toIsoUtc } from "./time.js";
import { useScratchDatabase, useTemporaryDatabase } from "./testing.js";

/**
 * The driver itself (spec.md §25.2). Everything else in this package is tested
 * through the queries it runs; this file tests the three things the *adapter*
 * owns, each of which fails silently rather than loudly if it is wrong.
 */
describe("the SQLite adapter", () => {
  beforeAll(async () => {
    await useTemporaryDatabase("cognitive-memory-db");
  });

  afterAll(() => {
    closeDb();
  });

  it("binds a reused `$1` placeholder once per occurrence, not once per parameter", async () => {
    // Postgres placeholders are numbered and reusable; SQLite's `?` are
    // positional. Several ported queries name the same parameter twice — the
    // anchor lookup uses `$1` in both of its EXISTS legs — so a translation that
    // emitted one `?` per distinct parameter would shift every later argument by
    // one and quietly match the wrong rows.
    const { rows } = await getDb().query<{ a: string; b: string; c: string }>(
      "SELECT $1 AS a, $2 AS b, $1 AS c",
      ["first", "second"]
    );
    expect(rows[0]).toEqual({ a: "first", b: "second", c: "first" });
  });

  it("does not rewrite a `$n` that is inside a literal, an identifier or a comment", async () => {
    // The hazard this guards is silent, not loud: a blind replace over the whole
    // SQL string would turn a `$1` inside a JSON path or a comment into a bound
    // parameter and shift every argument after it by one, producing a query that
    // matches the wrong rows rather than one that fails to parse.
    //
    // Every case below is a place a `$` legitimately appears in SQL this package
    // either writes today (`"timestamp"` as a quoted identifier, `'$.path'` JSON
    // paths, `--` comments inside multi-line queries) or could write tomorrow.
    const { rows } = await getDb().query<{ a: string; b: string; c: string }>(
      `SELECT $1 AS a,               -- a real placeholder, and a $2 in a comment
              '$1 is not a parameter' AS b,
              /* nor is $2 in a block comment */
              json_extract('{"$1":"literal path"}', '$."$1"') AS c`,
      ["bound"]
    );
    expect(rows[0]).toEqual({ a: "bound", b: "$1 is not a parameter", c: "literal path" });
  });

  it("reports a placeholder that has no parameter rather than binding undefined", async () => {
    await expect(getDb().query("SELECT $1, $2", ["only one"])).rejects.toThrow(
      /references \$2 but only 1 parameters/
    );
  });

  it("refuses to bind an array instead of stringifying it", async () => {
    // Postgres took `text[]` and `jsonb[]` parameters directly and SQLite has
    // neither, so spec.md §25.5 rewrote every such site to pass JSON text
    // consumed by `json_each`. An array reaching the driver therefore means a
    // site was missed — and binding `[object Object]` would match nothing and
    // read as "no results" rather than as a bug.
    await expect(
      getDb().query("SELECT $1 AS a", [["one", "two"]])
    ).rejects.toThrow(/json_each/);
  });

  it("coerces booleans and Dates the way the visibility predicate and timestamps expect", async () => {
    const { rows } = await getDb().query<{ t: number; f: number; d: string }>(
      "SELECT $1 AS t, $2 AS f, $3 AS d",
      [true, false, new Date("2026-08-21T09:15:00.000Z")]
    );
    expect(rows[0]).toEqual({ t: 1, f: 0, d: "2026-08-21T09:15:00.000Z" });
  });

  it("reports rows changed for a write and rows returned for a read", async () => {
    await getDb().query("CREATE TABLE adapter_probe (id INTEGER PRIMARY KEY, v TEXT)");
    const insert = await getDb().query("INSERT INTO adapter_probe (v) VALUES ($1), ($2)", [
      "a",
      "b",
    ]);
    expect(insert.rowCount).toBe(2);
    expect(insert.rows).toEqual([]);
    const select = await getDb().query("SELECT v FROM adapter_probe ORDER BY v");
    expect(select.rowCount).toBe(2);
  });

  it("rolls a failed transaction back and keeps the queue usable afterwards", async () => {
    await getDb().query("DELETE FROM adapter_probe");
    await expect(
      withTransaction(async (tx) => {
        await tx.query("INSERT INTO adapter_probe (v) VALUES ('doomed')");
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    // Both halves matter. The rollback is the obvious one; the second is that a
    // rejected transaction must not poison the promise chain the queue is built
    // on, or one failure would reject every transaction queued behind it.
    const after = await withTransaction(async (tx) => {
      await tx.query("INSERT INTO adapter_probe (v) VALUES ('survivor')");
      return tx.query<{ v: string }>("SELECT v FROM adapter_probe ORDER BY v");
    });
    expect(after.rows.map((row) => row.v)).toEqual(["survivor"]);
  });

  it("serializes concurrent transactions instead of interleaving them", async () => {
    // SQLite's write lock is per-process-pair; inside ONE process two async
    // transactions share the connection, so without the queue their statements
    // would interleave between BEGIN and COMMIT. The observable is that the
    // second transaction sees the first's committed row, never a partial state.
    await getDb().query("DELETE FROM adapter_probe");
    const order: string[] = [];
    await Promise.all([
      withTransaction(async (tx) => {
        await tx.query("INSERT INTO adapter_probe (v) VALUES ('one')");
        await new Promise((resolve) => setTimeout(resolve, 40));
        const { rows } = await tx.query<{ n: number }>("SELECT count(*) AS n FROM adapter_probe");
        order.push(`first saw ${rows[0]?.n}`);
      }),
      withTransaction(async (tx) => {
        const { rows } = await tx.query<{ n: number }>("SELECT count(*) AS n FROM adapter_probe");
        await tx.query("INSERT INTO adapter_probe (v) VALUES ('two')");
        order.push(`second saw ${rows[0]?.n}`);
      }),
    ]);
    expect(order).toEqual(["first saw 1", "second saw 1"]);
  });

  it("rolls an untransacted write back with the transaction it silently joined", async () => {
    // Documented behaviour, pinned rather than designed around: there is one
    // connection, so a bare `getDb().query(...)` issued while a transaction is
    // open lands INSIDE that transaction. Under Postgres the same call went out
    // on another pooled connection and committed independently. Nothing in this
    // package writes that way — the branded `TransactionClient` is what keeps
    // it that way — but if something starts to, this is the shape of the bug it
    // gets, and the test says so out loud instead of leaving it to be
    // rediscovered.
    await getDb().query("DELETE FROM adapter_probe");
    await expect(
      withTransaction(async (tx) => {
        await tx.query("INSERT INTO adapter_probe (v) VALUES ('inside')");
        await getDb().query("INSERT INTO adapter_probe (v) VALUES ('outside')");
        throw new Error("abort");
      })
    ).rejects.toThrow("abort");
    const { rows } = await getDb().query<{ n: number }>(
      "SELECT count(*) AS n FROM adapter_probe"
    );
    expect(rows[0]?.n).toBe(0);
  });

  it("refuses a nested transaction rather than deadlocking on its own queue", async () => {
    // A nested `withTransaction` would wait for a queue slot the outer
    // transaction is holding, i.e. hang forever. A caller that needs to join an
    // open transaction takes the `TransactionClient` as a parameter — the
    // pattern `recordSupersedingExperience` uses.
    await expect(
      withTransaction(async () => {
        await withTransaction(async () => undefined);
      })
    ).rejects.toThrow(/cannot be nested/);
  });
});

describe("toIsoUtc (spec.md §25.5's TEXT timestamps)", () => {
  it("normalizes git's offset form to UTC so the column sorts correctly", () => {
    // This is the whole reason the helper exists: `packages/capture` stamps a
    // mined memory with git's `%aI`, and a TEXT column holding a mix of
    // `+02:00` and `Z` compares lexicographically — which breaks both
    // `ORDER BY "timestamp"` and §24.2.3's staleness comparison, silently, and
    // only for the rows that came from git.
    expect(toIsoUtc("2024-05-01T12:34:56+02:00")).toBe("2024-05-01T10:34:56.000Z");
    expect(toIsoUtc("2024-05-01T10:34:56.000Z")).toBe("2024-05-01T10:34:56.000Z");
    expect(toIsoUtc(new Date(0))).toBe("1970-01-01T00:00:00.000Z");
  });

  it("passes null through and throws on something that is not a timestamp", () => {
    expect(toIsoUtc(null)).toBeNull();
    expect(toIsoUtc(undefined)).toBeNull();
    expect(() => toIsoUtc("last tuesday")).toThrow(/not a timestamp/);
  });
});

describe("a transaction queued across a closeDb()", () => {
  beforeAll(async () => {
    await useTemporaryDatabase("cognitive-memory-db-closed");
    await getDb().query("CREATE TABLE probe (v TEXT)");
  });

  it("fails on the connection it was called against instead of reopening the default one", async () => {
    // The hazard is specific and silent: `withTransaction` used to resolve
    // `getDb()` when the QUEUE reached it, so a transaction enqueued behind
    // another and a `closeDb()` in between would open a brand new connection to
    // `defaultDatabasePath()` — i.e. a test or an eval harness committing into
    // the repo's real `.claude/memory.db`. Binding the handle at call time turns
    // that into a closed-connection error.
    const first = withTransaction(async (tx) => {
      await tx.query("INSERT INTO probe (v) VALUES ('first')");
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const second = withTransaction(async (tx) => {
      await tx.query("INSERT INTO probe (v) VALUES ('second')");
    });
    closeDb();
    await expect(Promise.allSettled([first, second])).resolves.toEqual([
      expect.objectContaining({ status: "rejected" }),
      expect.objectContaining({ status: "rejected" }),
    ]);
    await expect(second).rejects.toThrow(/not open/i);
  });
});

describe("useScratchDatabase (keeping harnesses out of the live memory)", () => {
  it("refuses to run without MEMORY_DB rather than defaulting into this repo's memory", async () => {
    const saved = process.env["MEMORY_DB"];
    try {
      delete process.env["MEMORY_DB"];
      // The message has to name the file, because the failure it prevents is
      // invisible: a harness mining a foreign repo into `.claude/memory.db`
      // leaves no marker and there is no un-mine.
      await expect(useScratchDatabase("why-spike")).rejects.toThrow(/\.claude\/memory\.db/);
    } finally {
      if (saved === undefined) delete process.env["MEMORY_DB"];
      else process.env["MEMORY_DB"] = saved;
    }
  });

  it("migrates the file it opens, so a harness pointed at a fresh path works", async () => {
    // `getDb()` creates the file on open but nothing in it. Without the
    // migration the documented reproduce command in BENCHMARKS.md fails with
    // `no such table: experiences` on a clean machine — which reads as a broken
    // port rather than an unmigrated file.
    const saved = process.env["MEMORY_DB"];
    const dir = mkdtempSync(join(tmpdir(), "cognitive-memory-scratch-"));
    try {
      process.env["MEMORY_DB"] = join(dir, "fresh.db");
      expect(await useScratchDatabase("why-spike")).toBe(process.env["MEMORY_DB"]);
      const { rows } = await getDb().query<{ n: number }>(
        "SELECT count(*) AS n FROM experiences"
      );
      expect(rows[0]?.n).toBe(0);
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
      if (saved === undefined) delete process.env["MEMORY_DB"];
      else process.env["MEMORY_DB"] = saved;
    }
  });
});
