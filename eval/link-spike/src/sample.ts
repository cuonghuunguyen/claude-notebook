/**
 * Mines the corpus and emits (a) coverage statistics and (b) a stratified,
 * deterministic sample of candidate edges for a human to label
 * (ROADMAP.md M14: "Hand-check edge precision on a labeled sample (target: a
 * real number in the report, not an assertion)").
 *
 * The sample carries both commits' subject and a body excerpt, because
 * precision is not judgeable from a sha pair — the labeller has to read what
 * the two commits actually say. Sampling is seeded, so re-running produces the
 * same sample and an existing label file stays valid.
 *
 * When `labels/precision-labels.json` exists, this script also scores it: the
 * precision number in `BENCHMARKS.md` is computed here from the labels, never
 * typed in by hand.
 */
import fs from "node:fs";
import path from "node:path";
import { isExplanatory } from "@cognitive-memory/capture";
import { commitLimit, labelsDir, pathScope, repoDir, resultsDir } from "./config.js";
import {
  mineKnowledgeLinks,
  readCommitLog,
  readCorpusRevision,
  type KnowledgeLink,
  type LinkRelation,
} from "./miner.js";

const RELATIONS: LinkRelation[] = ["reverts", "shares_issue", "follows_up"];
/** Per-relation sample size. Small enough to hand-read every pair, large enough to separate 0.9 from 0.4. */
const SAMPLE_PER_RELATION = Number(process.env["LINK_SPIKE_SAMPLE"] ?? 12);

export interface LabelRecord {
  pair: string;
  relation: LinkRelation;
  /**
   * `true` when a reader who retrieved one of these two memories would be
   * better off also seeing the other — i.e. the two commits belong to one
   * concrete change or decision thread. `false` when they merely co-occur.
   */
  related: boolean;
  /** One line of justification, so the label is auditable rather than asserted. */
  why: string;
}

/** Deterministic PRNG, so the sample (and therefore the label file) is stable across runs. */
function seededShuffle<T>(items: T[], seed: number): T[] {
  let state = seed >>> 0;
  const next = (): number => {
    // xorshift32 — no dependency, and reproducible on any machine.
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    const a = out[i]!;
    const b = out[j]!;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

const excerpt = (text: string, max = 400): string =>
  text.length <= max ? text : `${text.slice(0, max)}…`;

export const pairId = (link: KnowledgeLink): string => `${link.from}->${link.to}`;

async function main(): Promise<void> {
  const revision = await readCorpusRevision(repoDir());
  const commits = await readCommitLog(repoDir(), pathScope(), commitLimit());
  const links = mineKnowledgeLinks(commits);
  const byShortSha = new Map(commits.map((c) => [c.shortSha, c]));

  // Which commits `packages/capture` would actually record as memories. An
  // edge whose ends are not both memories cannot be traversed at retrieval
  // time, so this ratio is a first-class result, not a footnote.
  //
  // `isExplanatory` alone is the whole predicate here only because
  // `readCommitLog` already applies capture's other two filters (the `/tests/`
  // exclusion and the drop of commits left with no in-scope file).
  const isMemory = (sha: string): boolean => {
    const c = byShortSha.get(sha);
    return !!c && isExplanatory(c.subject, c.body);
  };
  const memoryCommits = commits.filter((c) => isExplanatory(c.subject, c.body));
  const memoryLinks = links.filter((l) => isMemory(l.from) && isMemory(l.to));

  const perRelation = (subset: KnowledgeLink[]) =>
    Object.fromEntries(RELATIONS.map((r) => [r, subset.filter((l) => l.relation === r).length]));

  const coverage = {
    corpusRevision: revision,
    commitsScanned: commits.length,
    memoryCommits: memoryCommits.length,
    candidateLinks: links.length,
    candidateLinksByRelation: perRelation(links),
    /** Edges usable at retrieval time: both ends are memories. */
    memoryToMemoryLinks: memoryLinks.length,
    memoryToMemoryByRelation: perRelation(memoryLinks),
    /** Fraction of memories with at least one 1-hop neighbour that is also a memory. */
    memoriesWithAtLeastOneLink:
      memoryCommits.filter((c) =>
        memoryLinks.some((l) => l.from === c.shortSha || l.to === c.shortSha)
      ).length / (memoryCommits.length || 1),
  };

  // Sample from the memory-to-memory subset: those are the only edges the
  // product could ever traverse, so precision on the full candidate set would
  // measure something the system never uses.
  const sample: Record<string, unknown>[] = [];
  for (const relation of RELATIONS) {
    const pool = memoryLinks.filter((l) => l.relation === relation);
    // A distinct seed per relation, so adding a relation later does not
    // reshuffle the ones already labelled.
    const seed = relation.length * 7919 + relation.charCodeAt(0);
    for (const link of seededShuffle(pool, seed).slice(0, SAMPLE_PER_RELATION)) {
      const from = byShortSha.get(link.from);
      const to = byShortSha.get(link.to);
      sample.push({
        pair: pairId(link),
        relation,
        evidence: link.evidence,
        later: from && {
          sha: from.shortSha,
          date: from.date,
          subject: from.subject,
          body: excerpt(from.body),
          files: from.files,
        },
        earlier: to && {
          sha: to.shortSha,
          date: to.date,
          subject: to.subject,
          body: excerpt(to.body),
          files: to.files,
        },
      });
    }
  }

  fs.mkdirSync(resultsDir(), { recursive: true });
  fs.writeFileSync(
    path.join(resultsDir(), "sample.json"),
    JSON.stringify({ coverage, sampledPerRelation: SAMPLE_PER_RELATION, sample }, null, 2)
  );

  const scored = scoreLabels(
    sample.map((s) => String(s["pair"])),
    sample,
    coverage.memoryToMemoryByRelation as Record<string, number>
  );
  fs.writeFileSync(
    path.join(resultsDir(), "coverage.json"),
    JSON.stringify({ coverage, precision: scored }, null, 2)
  );

  console.log(JSON.stringify({ coverage, precision: scored }, null, 2));
}

/**
 * Scores `labels/precision-labels.json` against the sample that was actually
 * emitted, so a stale label file (one written for a different sample) is a
 * loud error rather than a silently wrong precision number.
 */
function scoreLabels(
  sampledPairs: string[],
  sample: Record<string, unknown>[],
  populationByRelation: Record<string, number>
): Record<string, unknown> | null {
  const file = path.join(labelsDir(), "precision-labels.json");
  if (!fs.existsSync(file)) return null;
  const labels = JSON.parse(fs.readFileSync(file, "utf8")) as { labels: LabelRecord[] };
  const byPair = new Map(labels.labels.map((l) => [l.pair, l]));
  const missing = sampledPairs.filter((p) => !byPair.has(p));
  if (missing.length > 0) {
    throw new Error(
      `label file is stale: ${missing.length} sampled pair(s) unlabelled, e.g. ${missing.slice(0, 3).join(", ")}`
    );
  }

  const relationOf = new Map(sample.map((s) => [String(s["pair"]), String(s["relation"])]));
  const out: Record<string, unknown> = {};
  for (const relation of [...RELATIONS, "overall"]) {
    const subset = sampledPairs.filter((p) => relation === "overall" || relationOf.get(p) === relation);
    const positives = subset.filter((p) => byPair.get(p)?.related).length;
    out[relation] = {
      labelled: subset.length,
      related: positives,
      precision: subset.length ? Number((positives / subset.length).toFixed(3)) : null,
    };
  }

  // `overall` above is an unweighted mean over an *equal-n stratified* sample
  // (12 + 12 + 1), so it is NOT the precision of the edge population: it
  // over-weights the tiny `reverts` stratum ~79x and under-weights
  // `follows_up`, the relation that dominates the real edge set. Quoting it as
  // "the miner's precision" flatters the miner by ~0.2 here. The weighted
  // figure re-weights each stratum's measured precision by how many
  // memory-to-memory edges that relation actually contributes.
  let weightedNumerator = 0;
  let population = 0;
  for (const relation of RELATIONS) {
    const stratum = out[relation] as { labelled: number; precision: number | null };
    const size = populationByRelation[relation] ?? 0;
    population += size;
    if (stratum.labelled > 0 && stratum.precision !== null) {
      weightedNumerator += stratum.precision * size;
    }
  }
  out["populationWeighted"] = {
    note: "per-relation precision re-weighted by each relation's share of the memory-to-memory edge population; this is the number to quote as the miner's precision",
    edges: population,
    estimatedRelatedEdges: Number(weightedNumerator.toFixed(1)),
    precision: population ? Number((weightedNumerator / population).toFixed(3)) : null,
  };
  return out;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
