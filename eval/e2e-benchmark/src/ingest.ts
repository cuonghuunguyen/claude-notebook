/**
 * Ingests the real-world target repo (zod v4 classic+core) into the
 * cognitive-memory graph end to end: structural extraction (ts-morph) →
 * persistExtraction (Postgres, event log) → embedding indexing (vector leg).
 *
 * Also records a small set of clearly-synthetic agent experiences against
 * real nodes, so the episodic read path is exercised e2e (they are labeled
 * synthetic — the benchmark report calls this out rather than pretending
 * they came from real agent sessions).
 */
import fs from "node:fs";
import path from "node:path";
import { recordExperience } from "@cognitive-memory/episodic";
import { closePool, getPool, runMigrations } from "@cognitive-memory/graph-store";
import { createFakeEmbedder, indexNodeEmbeddings } from "@cognitive-memory/retrieval";
import { extractProject, loadProject, persistExtraction } from "@cognitive-memory/structural";
import { REPO_ID, resultsDir, sourceGlobs, zodRoot } from "./config.js";

async function main(): Promise<void> {
  const root = zodRoot();
  await runMigrations();

  const t0 = Date.now();
  const project = loadProject(root);
  project.addSourceFilesAtPaths(sourceGlobs(root));
  const fileCount = project.getSourceFiles().length;
  const extraction = extractProject(project, REPO_ID);
  const tExtract = Date.now() - t0;

  const t1 = Date.now();
  await persistExtraction(extraction, REPO_ID);
  const tPersist = Date.now() - t1;

  const t2 = Date.now();
  await indexNodeEmbeddings(extraction.nodes, createFakeEmbedder());
  const tIndex = Date.now() - t2;

  // Synthetic experiences on real nodes — exercises episodic hydration e2e.
  const byPath = (suffix: string) =>
    extraction.nodes.find((n) => n.type === "file" && n.path?.endsWith(suffix));
  const schemasFile = byPath("v4/core/schemas.ts");
  const checksFile = byPath("v4/core/checks.ts");
  const seeded: string[] = [];
  for (const [node, lesson] of [
    [schemasFile, "[synthetic] core/schemas.ts is a ~10k-line module; schema classes are defined via $constructor, not `class X {}` declarations."],
    [checksFile, "[synthetic] String/number checks live in core/checks.ts as $ZodCheck* constructors; the regexes they use live in core/regexes.ts."],
  ] as const) {
    if (!node) continue;
    await recordExperience({
      task: "e2e-benchmark seeding",
      observation: lesson,
      lessons: [lesson],
      relatedNodes: [node.id],
      confidence: 0.9,
    });
    seeded.push(node.path ?? node.id);
  }

  const summary = {
    repoId: REPO_ID,
    root,
    filesParsed: fileCount,
    nodes: extraction.nodes.length,
    edges: extraction.edges.length,
    nodesByType: extraction.nodes.reduce<Record<string, number>>((acc, n) => {
      acc[n.type] = (acc[n.type] ?? 0) + 1;
      return acc;
    }, {}),
    nodesInStore: Number(
      (await getPool().query("SELECT count(*) FROM nodes WHERE repo_id = $1", [REPO_ID])).rows[0].count
    ),
    syntheticExperiencesOn: seeded,
    timingsMs: { extract: tExtract, persist: tPersist, indexEmbeddings: tIndex },
  };

  fs.mkdirSync(resultsDir(), { recursive: true });
  fs.writeFileSync(path.join(resultsDir(), "ingest.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  await closePool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
