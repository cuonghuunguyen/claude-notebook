/**
 * Fills the database with the corpus the probe reads, using the shipped
 * `captureGitHistory` from `packages/capture` — no spike-local persistence.
 *
 * Anchors are the commit's own paths as plain text: M14 never touched the
 * structural graph, and by-meaning retrieval never dereferenced a node id
 * (spec.md §24.2.1). Through M14 that was a deliberate contrast with
 * `eval/why-spike/src/capture.ts`, which bound node ids as well so the
 * node-gated baseline arm had something to hydrate; M15 removed the graph, the
 * arm and the `resolveNodeIds` option, so text anchors are simply what capture
 * writes now.
 */
import { captureGitHistory } from "@cognitive-memory/capture";
import { closePool } from "@cognitive-memory/graph-store";
import { createFakeEmbedder } from "@cognitive-memory/core";
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
