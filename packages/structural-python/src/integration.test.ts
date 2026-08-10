import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closePool, getEdgesTouchingNode, getNodeById, getPool, runMigrations } from "@cognitive-memory/graph-store";
import { extractChangedFiles } from "./incremental.js";
import { extractProject, projectFromSourceFiles } from "./extract.js";

// Same DATABASE_URL-gating convention as packages/graph-store and
// packages/structural — see either package's integration.test.ts for why
// these are skipped, not failed, when no DB is configured.
const hasDb = Boolean(process.env["DATABASE_URL"]);
const d = hasDb ? describe : describe.skip;

d("python structural extractor -> graph-store integration", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await closePool();
  });

  it("full ingest, then incremental rename, then incremental delete — through real Postgres", async () => {
    const repoId = `structural-python-test-${randomUUID()}`;

    // 1. Initial ingest: treat every file as "changed".
    const v1Files = {
      "/src/bar.py": `def helper(x):\n    return x + 1\n`,
      "/src/foo.py": `
from .bar import helper


class FooService:
    def run(self, x):
        return helper(x)
`,
    };
    const v1Project = projectFromSourceFiles(v1Files);
    const v1Expected = extractProject(v1Project, repoId);
    const v1Result = await extractChangedFiles(v1Project, Object.keys(v1Files), repoId);
    expect(v1Result.upsertedNodes).toBe(v1Expected.nodes.length);
    expect(v1Result.deletedNodes).toHaveLength(0);

    const methodNode = v1Expected.nodes.find((n) => n.type === "method");
    const fnNode = v1Expected.nodes.find((n) => n.type === "function");
    expect(methodNode).toBeDefined();
    expect(fnNode).toBeDefined();

    const persistedMethod = await getNodeById(methodNode!.id);
    expect(persistedMethod?.name).toBe("run");
    const callEdges = await getEdgesTouchingNode(methodNode!.id);
    expect(callEdges.some((e) => e.relation === "calls" && e.to === fnNode!.id)).toBe(true);

    // 2. Incremental rename: only foo.py changes, method renamed, same shape.
    const v2Files = {
      ...v1Files,
      "/src/foo.py": `
from .bar import helper


class FooService:
    def execute(self, x):
        return helper(x)
`,
    };
    const v2Project = projectFromSourceFiles(v2Files);
    const v2Result = await extractChangedFiles(v2Project, ["/src/foo.py"], repoId);
    expect(v2Result.deletedNodes).toHaveLength(0); // rename, not delete+create

    const renamed = await getNodeById(methodNode!.id);
    expect(renamed?.id).toBe(methodNode!.id); // identity preserved across the rename
    expect(renamed?.name).toBe("execute");

    // 3. Incremental delete: bar.py's helper function is removed entirely.
    const v3Files = {
      ...v2Files,
      "/src/bar.py": `def unrelated():\n    pass\n`,
    };
    const v3Project = projectFromSourceFiles(v3Files);
    const v3Result = await extractChangedFiles(v3Project, ["/src/bar.py"], repoId);
    expect(v3Result.deletedNodes).toContain(fnNode!.id);
    expect(v3Result.staleEdges).toBeGreaterThan(0);

    const deletedFn = await getNodeById(fnNode!.id);
    expect(deletedFn?.status).toBe("deleted");
    const staleEdges = await getEdgesTouchingNode(fnNode!.id);
    expect(staleEdges.every((e) => e.status === "stale")).toBe(true);
  });

  it("smoke-checks the pool is reachable", async () => {
    const pool = getPool();
    const { rows } = await pool.query("SELECT 1 as one");
    expect(rows[0]?.one).toBe(1);
  });

  it("batches all of one incremental call's deletions into a single transaction, not one per deleted node", async () => {
    const repoId = `structural-python-batch-test-${randomUUID()}`;

    const v1Files = {
      "/src/multi.py": `
def a():
    return 1


def b():
    return 2


def c():
    return 3
`,
    };
    await extractChangedFiles(projectFromSourceFiles(v1Files), Object.keys(v1Files), repoId);

    const connectSpy = vi.spyOn(getPool(), "connect");

    const v2Project = projectFromSourceFiles({ "/src/multi.py": `def unrelated():\n    pass\n` });
    const result = await extractChangedFiles(v2Project, ["/src/multi.py"], repoId);

    expect(result.deletedNodes).toHaveLength(3);
    // 1 connect() from getNodesByPath's pool.query() (node-postgres's
    // Pool.query checks out a connection internally) + 1 for the batched
    // deletion transaction + 1 for persistExtraction's own transaction = 3,
    // regardless of how many nodes get deleted.
    expect(connectSpy).toHaveBeenCalledTimes(3);

    connectSpy.mockRestore();
  });
});
