/**
 * Ingests the active real-world target repo into the cognitive-memory graph
 * end to end: structural extraction (ts-morph) → persistExtraction (Postgres,
 * event log) → embedding indexing (vector leg).
 *
 * Targets that declare `episodicSeeds` also get a small set of clearly-labeled
 * synthetic agent experiences recorded against real nodes, so the episodic
 * read path is exercised e2e. The lodash target deliberately declares none —
 * its episodic numbers come from experiences a real agent session produced
 * (sessionChain.ts) rather than invented ones.
 */
import fs from "node:fs";
import path from "node:path";
import { recordExperience } from "@cognitive-memory/episodic";
import { closePool, getPool, runMigrations } from "@cognitive-memory/graph-store";
import { createFakeEmbedder, indexNodeEmbeddings } from "@cognitive-memory/retrieval";
import { extractProject, persistExtraction } from "@cognitive-memory/structural";
import { Project } from "ts-morph";
import { activeTarget, resultsDir, targetRoot } from "./config.js";

async function main(): Promise<void> {
  const target = activeTarget();
  const root = targetRoot(target);
  await runMigrations();

  const t0 = Date.now();
  // The project is constructed here rather than via structural's
  // `loadProject()` because that helper exposes no way to set compiler
  // options, and plain-JS targets need `allowJs` — see targets/lodash.ts.
  const project = new Project({
    compilerOptions: { rootDir: root, ...(target.compilerOptions ?? {}) },
  });
  project.addSourceFilesAtPaths(target.sourceGlobs(root));
  const fileCount = project.getSourceFiles().length;
  const extraction = extractProject(project, target.repoId);
  const tExtract = Date.now() - t0;

  const t1 = Date.now();
  await persistExtraction(extraction, target.repoId);
  const tPersist = Date.now() - t1;

  const t2 = Date.now();
  await indexNodeEmbeddings(extraction.nodes, createFakeEmbedder());
  const tIndex = Date.now() - t2;

  const seeded: string[] = [];
  for (const seed of target.episodicSeeds ?? []) {
    const node = extraction.nodes.find(
      (n) => n.type === "file" && n.path?.endsWith(seed.fileSuffix)
    );
    if (!node) continue;
    await recordExperience({
      task: "e2e-benchmark seeding",
      observation: seed.lesson,
      lessons: [seed.lesson],
      relatedNodes: [node.id],
      confidence: 0.9,
    });
    seeded.push(node.path ?? node.id);
  }

  const summary = {
    target: target.key,
    repoId: target.repoId,
    origin: target.origin,
    root,
    filesParsed: fileCount,
    nodes: extraction.nodes.length,
    edges: extraction.edges.length,
    nodesByType: extraction.nodes.reduce<Record<string, number>>((acc, n) => {
      acc[n.type] = (acc[n.type] ?? 0) + 1;
      return acc;
    }, {}),
    edgesByRelation: extraction.edges.reduce<Record<string, number>>((acc, e) => {
      acc[e.relation] = (acc[e.relation] ?? 0) + 1;
      return acc;
    }, {}),
    nodesInStore: Number(
      (await getPool().query("SELECT count(*) FROM nodes WHERE repo_id = $1", [target.repoId]))
        .rows[0].count
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
