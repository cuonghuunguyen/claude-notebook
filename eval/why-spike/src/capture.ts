/**
 * Runs the shipped git-history capture (`packages/capture`) against the zod
 * clone, so the corpus this harness probes is produced by the product, not by
 * the spike.
 *
 * Before M11 this file contained its own miner and its own persistence loop.
 * Both moved into `packages/capture`; what is left here is the target-specific
 * wiring (which repo, which path scope, how to resolve the file nodes the
 * pre-M11 node-gated arm needs to have something to hydrate).
 */
import { captureGitHistory } from "@cognitive-memory/capture";
import { closePool, getPool } from "@cognitive-memory/graph-store";
import { createFakeEmbedder } from "@cognitive-memory/retrieval";
import { REPO_ID, repoDir, pathScope } from "./config.js";

/**
 * Maps repo-relative commit paths onto the absolute paths stored at ingest.
 * Only the node-gated *baseline* needs this — by-meaning retrieval never
 * dereferences a node id (spec.md §24.2.1).
 */
async function fileNodeResolver(): Promise<(paths: string[]) => string[]> {
  const { rows } = await getPool().query<{ id: string; path: string }>(
    "SELECT id, path FROM nodes WHERE repo_id = $1 AND type = 'file' AND path IS NOT NULL",
    [REPO_ID]
  );
  return (paths) => {
    const ids: string[] = [];
    for (const repoRelative of paths) {
      for (const row of rows) {
        if (row.path.endsWith(`/${repoRelative}`)) {
          ids.push(row.id);
          break;
        }
      }
    }
    return ids;
  };
}

async function main(): Promise<void> {
  const resolveNodeIds = await fileNodeResolver();
  const result = await captureGitHistory({
    repoDir: repoDir(),
    pathScope: pathScope(),
    resolveNodeIds,
    embedder: process.env["SPIKE_EMBEDDER"] === "fake" ? createFakeEmbedder() : undefined,
  });

  console.log(
    JSON.stringify(
      {
        commitsMined: result.mined,
        experiencesRecorded: result.recorded,
        skippedAlreadyRecorded: result.alreadyRecorded,
        skippedUnanchored: result.unanchored,
      },
      null,
      2
    )
  );
  await closePool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
