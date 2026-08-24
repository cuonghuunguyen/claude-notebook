/**
 * Retrieval-only A/B, no agent runs: on questions whose ground truth spans two
 * commits, does spending part of a fixed context budget on 1-hop linked
 * memories fill more gold slots than spending it all on by-meaning rank?
 *
 * Cheap half of the spike, same as `eval/why-spike/src/probe.ts`. If linked
 * memories cannot even be *retrieved* into the budget, an agent comparison has
 * nothing to measure.
 */
import fs from "node:fs";
import path from "node:path";
import { closeDb, useScratchDatabase } from "@cognitive-memory/graph-store";
import { createFakeEmbedder } from "@cognitive-memory/core";
import { commitLimit, pathScope, repoDir, resultsDir } from "./config.js";
import { buildAdjacency, mineKnowledgeLinks, readCommitLog, readCorpusRevision } from "./miner.js";
import { QUESTIONS, type GoldSlot, type LinkQuestion } from "./questions.js";
import {
  byMeaningArm,
  linkedArm,
  memoriesForShas,
  randomControlArm,
  strongLinkedArm,
  unbudgetedArm,
  type ArmOptions,
  type ArmResult,
} from "./retrieve.js";

/** Context budget, in memories. 5 is `queryByMeaning`'s default and the why-spike's value. */
const K = Number(process.env["LINK_SPIKE_K"] ?? 5);
/** How many of arm B's K slots stay with by-meaning before expansion takes over. */
const SEED_COUNT = Number(process.env["LINK_SPIKE_SEEDS"] ?? 3);

const embedder = process.env["LINK_SPIKE_EMBEDDER"] === "fake" ? createFakeEmbedder() : undefined;

/**
 * Seed for `randomControlArm`'s rewiring. Fixed so the control is reproducible;
 * `LINK_SPIKE_RANDOM_SEED` lets the reported figure be re-rolled to check it was
 * not one lucky draw (see the seed-sweep line in BENCHMARKS.md).
 */
const RANDOM_SEED = Number(process.env["LINK_SPIKE_RANDOM_SEED"] ?? 20260820);

/**
 * The five arms. `strongLinked` and `randomControl` are the two controls that
 * decide the go/no-go: without them a `linked` win is unattributable — it could
 * be the low-precision `follows_up` bulk carrying nothing, or simply "any extra
 * memory helps".
 */
const ARMS = ["byMeaning", "linked", "strongLinked", "randomControl", "unbudgeted"] as const;
type ArmName = (typeof ARMS)[number];

const fills = (result: ArmResult, slot: GoldSlot): boolean =>
  result.hits.some((h) => slot.shas.includes(h.shortSha));

interface ArmScore {
  /** Both halves of the answer present. */
  bothSlots: boolean;
  /** Per-slot, in question order. */
  slots: boolean[];
  returned: number;
  linksUsed: number;
  shas: string[];
}

const score = (question: LinkQuestion, result: ArmResult): ArmScore => ({
  bothSlots: question.gold.every((slot) => fills(result, slot)),
  slots: question.gold.map((slot) => fills(result, slot)),
  returned: result.hits.length,
  linksUsed: result.linksUsed.length,
  shas: result.hits.map((h) => h.shortSha),
});

async function main(): Promise<void> {
  await useScratchDatabase("link-spike");
  const revision = await readCorpusRevision(repoDir());
  const commits = await readCommitLog(repoDir(), pathScope(), commitLimit());
  const links = mineKnowledgeLinks(commits);
  const adjacency = buildAdjacency(links);
  const options: ArmOptions = { k: K, seedCount: SEED_COUNT, adjacency, embedder };

  // A gold sha that never became a memory is unreachable for *every* arm, which
  // would silently depress all of them and make the comparison meaningless.
  // Check it once, loudly, before scoring anything.
  const goldShas = QUESTIONS.flatMap((q) => q.gold.flatMap((s) => s.shas));
  const goldMemories = await memoriesForShas(goldShas);
  const unreachable = QUESTIONS.flatMap((q) =>
    q.gold
      .filter((slot) => !slot.shas.some((sha) => goldMemories.has(sha)))
      .map((slot) => `${q.id}/${slot.name} (${slot.shas.join("|")})`)
  );
  if (unreachable.length > 0) {
    throw new Error(
      `no memory was recorded for these gold slots — run capture first, or the commit is not explanatory: ${unreachable.join(", ")}`
    );
  }

  // Rewiring target pool for the random control: every commit in *this corpus*
  // that actually became a memory. Deliberately not "every memory in the
  // database" — on a database that also holds another corpus (this repo's own
  // self-memory, the why-spike's) the pool would fill with foreign memories,
  // `expandOneHop` would skip them, and the control would degenerate into
  // `byMeaningArm`: the exact lose-by-construction failure it exists to avoid.
  const memoryShas = [...(await memoriesForShas(commits.map((c) => c.shortSha))).keys()];

  const rows: Record<string, unknown>[] = [];
  const contexts: Record<string, Record<string, string>> = {};

  for (const q of QUESTIONS) {
    const byMeaning = await byMeaningArm(q.question, options);
    const linked = await linkedArm(q.question, options);
    const strongLinked = await strongLinkedArm(q.question, options);
    const randomControl = await randomControlArm(q.question, options, memoryShas, RANDOM_SEED);
    const unbudgeted = await unbudgetedArm(q.question, options);

    // Re-derive `linkedByMiner` instead of trusting the question file: if the
    // miner's rules change, a stale expectation must fail loudly rather than
    // quietly mislabel a row.
    const goldLinked = q.gold[0].shas.some((a) =>
      q.gold[1].shas.some((b) =>
        links.some((l) => (l.from === a && l.to === b) || (l.from === b && l.to === a))
      )
    );
    if (goldLinked !== q.linkedByMiner) {
      throw new Error(
        `questions.ts is stale: ${q.id} declares linkedByMiner=${q.linkedByMiner} but the miner says ${goldLinked}`
      );
    }

    contexts[q.id] = {
      byMeaning: byMeaning.hits.map((h) => h.shortSha).join(","),
      linked: linked.hits.map((h) => `${h.shortSha}${h.provenance === "linked" ? "*" : ""}`).join(","),
    };

    rows.push({
      id: q.id,
      linkedByMiner: goldLinked,
      gold: q.gold.map((s) => `${s.name}=${s.shas.join("|")}`),
      byMeaning: score(q, byMeaning),
      linked: score(q, linked),
      strongLinked: score(q, strongLinked),
      randomControl: score(q, randomControl),
      unbudgeted: score(q, unbudgeted),
    });

    const mark = (s: ArmScore) => s.slots.map((v) => (v ? "Y" : "-")).join("");
    const row = rows.at(-1)!;
    const m = (a: ArmName) => mark(row[a] as ArmScore);
    console.log(
      `${q.id.padEnd(24)} link=${goldLinked ? "yes" : "no "}  by-meaning ${m("byMeaning")}  linked ${m(
        "linked"
      )} (${(row["linked"] as ArmScore).linksUsed} edges)  strong ${m("strongLinked")}  random ${m(
        "randomControl"
      )}  unbudgeted ${m("unbudgeted")}`
    );
  }

  const summarize = (subset: Record<string, unknown>[], arm: ArmName) => {
    const scores = subset.map((r) => r[arm] as ArmScore);
    const slotTotal = scores.reduce((a, s) => a + s.slots.length, 0);
    const slotHits = scores.reduce((a, s) => a + s.slots.filter(Boolean).length, 0);
    return {
      questions: scores.length,
      bothSlots: scores.filter((s) => s.bothSlots).length,
      bothSlotsRate: round(scores.filter((s) => s.bothSlots).length / (scores.length || 1)),
      slotRecall: round(slotHits / (slotTotal || 1)),
      meanReturned: round(scores.reduce((a, s) => a + s.returned, 0) / (scores.length || 1)),
      totalLinksUsed: scores.reduce((a, s) => a + s.linksUsed, 0),
    };
  };

  const linkedSubset = rows.filter((r) => r["linkedByMiner"] === true);
  const unlinkedSubset = rows.filter((r) => r["linkedByMiner"] === false);

  const summary = {
    corpus: {
      repo: repoDir(),
      revision,
      scope: pathScope(),
      commitsScanned: commits.length,
      candidateLinks: links.length,
    },
    budget: { k: K, seedCount: SEED_COUNT, embedder: embedder ? "fake" : "lexical-only" },
    all: Object.fromEntries(ARMS.map((a) => [a, summarize(rows, a)])),
    // The honest split: questions whose gold pair the miner links are the only
    // ones the link arm could possibly help, and they are over-represented here
    // by construction (see questions.ts).
    goldPairLinked: Object.fromEntries(ARMS.map((a) => [a, summarize(linkedSubset, a)])),
    goldPairNotLinked: Object.fromEntries(ARMS.map((a) => [a, summarize(unlinkedSubset, a)])),
    perQuestion: rows,
    returnedShas: contexts,
  };

  fs.mkdirSync(resultsDir(), { recursive: true });
  fs.writeFileSync(path.join(resultsDir(), "probe.json"), JSON.stringify(summary, null, 2));
  console.log(
    "\n" +
      JSON.stringify(
        { all: summary.all, goldPairLinked: summary.goldPairLinked, goldPairNotLinked: summary.goldPairNotLinked },
        null,
        2
      )
  );
  await closeDb();
}

const round = (n: number): number => Number(n.toFixed(3));

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
