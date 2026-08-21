/**
 * Runs the shipped git-history capture (`packages/capture`) against the zod
 * clone, so the corpus this harness probes is produced by the product, not by
 * the spike.
 *
 * Before M11 this file contained its own miner and its own persistence loop;
 * both moved into `packages/capture`. Before M15 it also resolved the commit's
 * paths onto structural file nodes, so the node-gated baseline arm had
 * something to hydrate — that arm and the graph behind it are gone, and what
 * is left is the target-specific wiring: which repo, which path scope.
 */
import { captureGitHistory } from "@cognitive-memory/capture";
import { createFakeEmbedder } from "@cognitive-memory/core";
import { closePool } from "@cognitive-memory/graph-store";
import { repoDir, pathScope } from "./config.js";

async function main(): Promise<void> {
  const result = await captureGitHistory({
    repoDir: repoDir(),
    pathScope: pathScope(),
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
