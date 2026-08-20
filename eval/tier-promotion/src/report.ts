/**
 * Dogfood evidence for ROADMAP.md M16 / spec.md §24.5: run the promotion
 * comparison over THIS repository's own mined history, not a synthetic corpus.
 *
 *   DATABASE_URL=... node dist/report.js [repoDir]
 *
 * The synthetic arm in `tierPromotion.eval.test.ts` is what CI asserts on,
 * because it is deterministic and needs no clone. This script is what produces
 * the tier distribution quoted in the milestone's merge message: same policy,
 * same thresholds, but the corpus size and the retrieval skew come from real
 * memories mined out of real commits.
 */
import { captureGitHistory } from "@cognitive-memory/capture";
import {
  closePool,
  getPool,
  getTierDistribution,
  runMigrations,
} from "@cognitive-memory/graph-store";
import { recordRetrievalAccess, settleSession } from "@cognitive-memory/tiers";
import { buildTraffic, type TrafficModel } from "./model.js";
import { formatDistribution, replayStrategy, score } from "./strategies.js";

async function main(): Promise<void> {
  if (!process.env["DATABASE_URL"]) {
    throw new Error("DATABASE_URL is required (use a per-milestone database, not the shared one)");
  }
  const repoDir = process.argv[2] ?? process.cwd();

  await runMigrations();

  // Mine the whole repo, not just `packages/` — the commits that recorded this
  // project's own direction changes touch spec.md/ROADMAP.md at the root, and
  // a subtree-scoped mine cannot see them (CLAUDE.md).
  const captured = await captureGitHistory({ repoDir, pathScope: "", limit: 400 });
  const { rows } = await getPool().query<{ id: string }>(`SELECT id FROM experiences ORDER BY id`);
  const corpus = rows.map((r) => r.id);

  const traffic = buildTraffic(corpus);
  const raw = score(replayStrategy("raw", traffic, corpus), traffic);
  const broad = score(replayStrategy("broad", traffic, corpus), traffic);
  const narrow = score(replayStrategy("narrow", traffic, corpus), traffic);

  const out = [
    "spec.md §24.5 — access-driven promotion, measured on this repo's own history",
    "",
    `repo                 ${repoDir}`,
    `mined this run       ${captured.experiences.length} memories (${captured.alreadyRecorded} already recorded)`,
    `corpus               ${corpus.length} memories`,
    `modelled retrievals  ${traffic.events.length} sessions over ${traffic.retrievedIds.size} memories`,
    `plausible-but-wrong  ${traffic.misleadingIds.size} memories (ground truth for precision)`,
    "",
    "arm     tier distribution                                          boosted precision  wrong-in-boosted  sound-boosted",
    `raw     ${formatDistribution(raw.distribution).padEnd(57)}  ${raw.promotedPrecision.toFixed(3).padEnd(17)}  ${String(raw.misleadingPromoted).padEnd(16)}  ${raw.soundPromoted}`,
    `broad   ${formatDistribution(broad.distribution).padEnd(57)}  ${broad.promotedPrecision.toFixed(3).padEnd(17)}  ${String(broad.misleadingPromoted).padEnd(16)}  ${broad.soundPromoted}`,
    `narrow  ${formatDistribution(narrow.distribution).padEnd(57)}  ${narrow.promotedPrecision.toFixed(3).padEnd(17)}  ${String(narrow.misleadingPromoted).padEnd(16)}  ${narrow.soundPromoted}`,
    "",
    // The arms above are the pure policy replayed in-process. This last line
    // is the shipped code path — `recordRetrievalAccess` + `settleSession`
    // against real Postgres rows — so the distribution quoted in the merge
    // message is what the system actually does, not what the model predicts.
    `live distribution after driving the SHIPPED path over the same traffic:`,
    `  ${formatDistribution(await driveShippedPath(traffic))}`,
    "  (should match the `narrow` arm — the shipped rule is the narrow one)",
  ];
  // eslint-disable-next-line no-console
  console.log(out.join("\n"));

  await closePool();
}

/**
 * Replays the workload through the real accounting functions and returns the
 * tier histogram Postgres ends up holding.
 *
 * Sessions are settled in traffic order, one at a time, because that is how
 * production sees them: `settleSession` re-decides only the memories that
 * session touched, one promotion step per call. Batching them would quietly
 * measure a different algorithm.
 */
async function driveShippedPath(traffic: TrafficModel) {
  for (const event of traffic.events) {
    await recordRetrievalAccess(event.retrieved, event.sessionId);
    // The shipped contract: a passing task credits only what it reports
    // relying on. Passing `usedExperienceIds` is what makes this the `narrow`
    // rule rather than the `broad` one.
    await settleSession(event.sessionId, event.outcome, {
      usedExperienceIds: event.outcome === "confirmed" ? event.reliedOn : undefined,
    });
  }
  return getTierDistribution();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
