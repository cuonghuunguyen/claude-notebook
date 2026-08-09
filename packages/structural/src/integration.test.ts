import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getEdgesTouchingNode, getNodeById, getPool, runMigrations } from "@cognitive-memory/graph-store";
import { extractChangedFiles } from "./incremental.js";
import { extractProject, projectFromSourceFiles } from "./extract.js";

// Same DATABASE_URL-gating convention as packages/graph-store — see that
// package's integration.test.ts for why these are skipped, not failed,
// when no DB is configured.
const hasDb = Boolean(process.env["DATABASE_URL"]);
const d = hasDb ? describe : describe.skip;

d("structural extractor -> graph-store integration", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await closePool();
  });

  it("full ingest, then incremental rename, then incremental delete — through real Postgres", async () => {
    const repoId = `structural-test-${randomUUID()}`;

    // 1. Initial ingest: treat every file as "changed".
    const v1Files = {
      "/src/bar.ts": `export function helper(x: number): number { return x + 1; }`,
      "/src/foo.ts": `
        import { helper } from "./bar";
        export class FooService {
          run(x: number): number { return helper(x); }
        }
      `,
    };
    const v1Project = projectFromSourceFiles(v1Files);
    const v1Expected = extractProject(v1Project, repoId);
    const v1Result = await extractChangedFiles(
      v1Project,
      Object.keys(v1Files),
      repoId
    );
    expect(v1Result.upsertedNodes).toBe(v1Expected.nodes.length);
    expect(v1Result.deletedNodes).toHaveLength(0);

    const methodNode = v1Expected.nodes.find((n) => n.type === "method");
    const fnNode = v1Expected.nodes.find((n) => n.type === "function");
    expect(methodNode).toBeDefined();
    expect(fnNode).toBeDefined();

    const persistedMethod = await getNodeById(methodNode!.id);
    expect(persistedMethod?.name).toBe("run");
    const callEdges = await getEdgesTouchingNode(methodNode!.id);
    expect(callEdges.some((e) => e.relation === "calls" && e.to === fnNode!.id)).toBe(
      true
    );

    // 2. Incremental rename: only foo.ts changes, method renamed, same shape.
    const v2Files = {
      ...v1Files,
      "/src/foo.ts": `
        import { helper } from "./bar";
        export class FooService {
          execute(x: number): number { return helper(x); }
        }
      `,
    };
    const v2Project = projectFromSourceFiles(v2Files);
    const v2Result = await extractChangedFiles(v2Project, ["/src/foo.ts"], repoId);
    expect(v2Result.deletedNodes).toHaveLength(0); // rename, not delete+create

    const renamed = await getNodeById(methodNode!.id);
    expect(renamed?.id).toBe(methodNode!.id); // identity preserved across the rename
    expect(renamed?.name).toBe("execute");

    // 3. Incremental delete: bar.ts's helper function is removed entirely.
    const v3Files = {
      ...v2Files,
      "/src/bar.ts": `export function unrelated(): void {}`,
    };
    const v3Project = projectFromSourceFiles(v3Files);
    const v3Result = await extractChangedFiles(v3Project, ["/src/bar.ts"], repoId);
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
});
