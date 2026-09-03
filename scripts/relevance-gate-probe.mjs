#!/usr/bin/env node
/**
 * Relevance-gate probe (BENCHMARKS.md, 2026-09-03).
 *
 * Sweeps `minVectorScore` over two question sets against this repository's own
 * memory corpus, and reports the two things the gate trades:
 *
 *   on-repo answered — the answer is provably in the corpus (a documented
 *                      decision), so returning nothing is a recall failure
 *   off-repo leaked  — nothing to do with this project, so returning hits is
 *                      waste injected into an unrelated prompt
 *
 * BOTH sets are deliberately symmetric in shape: natural-language questions
 * AND bare keyword/identifier queries. An earlier version of this probe had
 * keyword-shaped questions only on the on-repo side, which put keyword shape
 * in scope for recall and out of scope for leakage — and a review found the
 * leaks lived exactly there. Keep them balanced.
 *
 * Run after `self-memory.mjs sync`:
 *   node scripts/relevance-gate-probe.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env["REPO_DIR"] ??= ROOT;

const core = await import(`${ROOT}/packages/core/dist/index.js`);
const gs = await import(`${ROOT}/packages/graph-store/dist/index.js`);
const ep = await import(`${ROOT}/packages/episodic/dist/index.js`);

const ON_REPO = [
  // natural language
  "why was the structural graph removed?",
  "how does staleness work?",
  "why are memories anchored to text not line numbers?",
  "why SQLite instead of Postgres?",
  "what does the trigram leg do?",
  "why did the knowledge-link edges spike get a no-go?",
  "how do memory tiers get promoted?",
  "what does the supersede chain do when a memory is corrected?",
  "why was distillation left off by default?",
  "how does the scout report get persisted?",
  // keyword / identifier shaped
  "listExperiencesByAnchorPaths",
  "fuseLegs weighted RRF",
  "createFakeEmbedder stopwords",
  "migration 0008 drops edges then nodes",
  "pg_advisory_lock",
  "word_similarity trigram threshold 0.35",
];
const OFF_REPO = [
  // natural language
  "how do I configure nginx TLS ciphers?",
  "what is the difference between a k8s deployment and a statefulset?",
  "how do I center a div with flexbox?",
  "write a bash script to rotate log files weekly",
  "what does the borrow checker do in Rust?",
  "how do I set up OAuth2 with Google?",
  "explain the CAP theorem",
  "what is the best way to debounce a react input?",
  // keyword / identifier shaped — the shape the previous probe was missing
  "flexbox justify-content",
  "docker-compose healthcheck",
  "kubernetes statefulset volumeClaimTemplates",
  "pthread_mutex_lock",
  "nginx gzip_types",
  "webpack splitChunks cacheGroups",
  "postgres VACUUM FULL lock",
  "react useEffect cleanup",
];

const FLOORS = process.env["FLOORS"]
  ? process.env["FLOORS"].split(",").map(Number)
  : [0, 0.1, 0.2, 0.3, 0.4, 0.5];

const embedder = process.env["EMBEDDER"] === "fake"
  ? core.createFakeEmbedder()
  : core.createLocalEmbedder();

const hits = async (question, floor) =>
  (await ep.queryByMeaning(question, {
    embedder,
    limit: 3,
    ...(floor > 0 ? { minVectorScore: floor } : {}),
  })).length;

console.log(`embedder=${process.env["EMBEDDER"] === "fake" ? "fake(hash)" : "local(all-MiniLM-L6-v2)"}`);
console.log("floor   on-repo answered   off-repo leaked");
const silentAt = new Map();
const leakedAt = new Map();
for (const floor of FLOORS) {
  const answered = [];
  const leaked = [];
  for (const q of ON_REPO) if ((await hits(q, floor)) > 0) answered.push(q);
  for (const q of OFF_REPO) if ((await hits(q, floor)) > 0) leaked.push(q);
  silentAt.set(floor, ON_REPO.filter((q) => !answered.includes(q)));
  leakedAt.set(floor, leaked);
  console.log(
    `${String(floor).padEnd(6)}  ${String(`${answered.length}/${ON_REPO.length}`).padStart(16)}   ${String(`${leaked.length}/${OFF_REPO.length}`).padStart(15)}`
  );
}
for (const floor of FLOORS) {
  const silent = silentAt.get(floor) ?? [];
  const leaked = leakedAt.get(floor) ?? [];
  if (silent.length === 0 && leaked.length === 0) continue;
  console.log(`\nfloor=${floor}`);
  for (const q of silent) console.log(`  silent: ${q}`);
  for (const q of leaked) console.log(`  leaked: ${q}`);
}

await gs.closeDb();
