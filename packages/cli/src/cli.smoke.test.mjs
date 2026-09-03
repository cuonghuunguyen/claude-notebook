/**
 * Smoke test for the CLI entrypoint.
 *
 * `cli.mjs` had no test at all: its only gate was `node --check`, which is
 * syntax-only, and a bulk edit that left `embedderOrNone` calling itself
 * shipped through it — every command died with a stack overflow, caught only
 * by a manual run. This runs each command in a subprocess against a throwaway
 * database and asserts it exits 0, so import, wiring and recursion breakage
 * fails here instead of in someone's terminal.
 *
 * `fetch` is stubbed to reject and `XDG_CACHE_HOME` points at an empty temp
 * dir, so the embedder cannot find a cached model or download one: the suite
 * stays offline and fast, and the commands take their real
 * "embeddings unavailable" branch. Node's own test runner — no framework,
 * because the CLI package has no test dependency and does not need one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const REPO = path.resolve(path.dirname(CLI), "..", "..", "..");
const OFFLINE = 'data:text/javascript,globalThis.fetch=()=>Promise.reject(new Error("offline"))';

function runCli(args) {
  const scratch = mkdtempSync(path.join(tmpdir(), "cli-smoke-"));
  return spawnSync(process.execPath, ["--import", OFFLINE, CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      REPO_DIR: REPO,
      MEMORY_DB: path.join(scratch, "memory.db"),
      XDG_CACHE_HOME: path.join(scratch, "cache"),
    },
  });
}

for (const args of [["stats"], ["stale"], ["suspects"], ["ask", "why", "sqlite"], ["sync"]]) {
  test(`\`${args.join(" ")}\` runs`, () => {
    const { status, stdout, stderr } = runCli(args);
    assert.equal(status, 0, `exit ${status}\n${stdout}\n${stderr}`);
    assert.doesNotMatch(stderr, /Maximum call stack|RangeError/, stderr);
  });
}

test("an unknown command exits 1 with usage", () => {
  const { status, stderr } = runCli(["nope"]);
  assert.equal(status, 1);
  assert.match(stderr, /usage: claude-notebook/);
});
