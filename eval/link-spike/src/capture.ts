/**
 * Fills the database with the corpus the probe reads, using the shipped
 * `captureGitHistory` from `packages/capture` — no spike-local persistence.
 *
 * Unlike `eval/why-spike/src/capture.ts` this passes no `resolveNodeIds`:
 * M14 never touches the structural graph, and by-meaning retrieval does not
 * dereference a node id (spec.md §24.2.1). Anchors are the commit's own paths
 * as plain text.
 */
import { captureGitHistory } from "@cognitive-memory/capture";
import { closePool } from "@cognitive-memory/graph-store";
import { createFakeEmbedder } from "@cognitive-memory/retrieval";
import { commitLimit, pathScope, repoDir } from "./config.js";

async function main(): Promise<void> {
  const result = await captureGitHistory({
    repoDir: repoDir(),
    pathScope: pathScope(),
    limit: commitLimit(),
    embedder: process.env["LINK_SPIKE_EMBEDDER"] === "fake" ? createFakeEmbedder() : undefined,
  });
  console.log(
    JSON.stringify(
      {
        commitsMined: result.mined,
        experiencesRecorded: result.recorded,
        skippedAlreadyRecorded: result.alreadyRecorded,
        skippedUnanchored: result.unanchored,
        embeddingsBackfilled: result.embeddingsBackfilled,
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
