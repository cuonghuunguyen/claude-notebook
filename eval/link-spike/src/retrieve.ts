/**
 * The three retrieval arms the spike compares.
 *
 * The comparison that matters is **budgeted**: an agent context has a size, so
 * a linked memory that gets added has to displace a by-meaning hit that would
 * otherwise have been there. Handing arm B extra records would measure "more
 * context beats less context", which is not the question.
 *
 *  - `byMeaningArm`  — K memories, all from `queryByMeaning`. The M11 product.
 *  - `linkedArm`     — K memories: the top `seedCount` by-meaning hits, then
 *                      1-hop neighbours along mined links, then by-meaning
 *                      ranks `seedCount+1…` as backfill if the links run dry.
 *  - `unbudgetedArm` — K by-meaning hits PLUS every 1-hop neighbour. Not a
 *                      product proposal; it is the ceiling, and it separates
 *                      "links carry nothing" from "links carry something that
 *                      is not worth a slot".
 */
import type { Experience } from "@cognitive-memory/core";
import { queryByMeaning } from "@cognitive-memory/episodic";
import { getDb } from "@cognitive-memory/graph-store";
import type { EmbeddingProvider } from "@cognitive-memory/core";
import { otherEnd, type KnowledgeLink } from "./miner.js";

/** How a memory got into an arm's result. */
export type Provenance = "by_meaning" | "linked" | "backfill";

export interface ArmHit {
  experience: Experience;
  shortSha: string;
  provenance: Provenance;
  /** For `linked`, the edge that pulled it in. */
  via?: KnowledgeLink;
}

export interface ArmResult {
  hits: ArmHit[];
  /** Edges actually traversed, so "the arm never used a link" is distinguishable from "it used one and it did not help". */
  linksUsed: KnowledgeLink[];
}

/** `Experience.action` is `commit <shortSha>` for everything the git miner records. */
const shaOf = (experience: Experience): string =>
  (experience.action ?? "").replace(/^commit /, "").trim();

interface Row {
  id: string;
  task: string;
  observation: string;
  action: string | null;
  lessons: string;
  related_nodes: string;
  confidence: number;
  timestamp: string;
}

const toExperience = (r: Row): Experience => ({
  id: r.id,
  task: r.task,
  observation: r.observation,
  action: r.action ?? undefined,
  lessons: JSON.parse(r.lessons) as string[],
  relatedNodes: JSON.parse(r.related_nodes) as string[],
  confidence: r.confidence,
  timestamp: r.timestamp,
});

/**
 * Bulk-loads the memories for a set of short shas.
 *
 * This is the operation a real memory-link traversal would need a schema for
 * (spec.md §24.4 defers that to a "go"). The spike reads `action` directly
 * rather than inventing a table, so a "no-go" leaves no migration behind.
 */
export async function memoriesForShas(shas: string[]): Promise<Map<string, Experience>> {
  if (shas.length === 0) return new Map();
  const { rows } = await getDb().query<Row>(
    `SELECT id, task, observation, action, lessons, related_nodes, confidence, "timestamp"
       FROM experiences
      WHERE action IN (SELECT value FROM json_each($1))`,
    [JSON.stringify(shas.map((s) => `commit ${s}`))]
  );
  return new Map(rows.map((r) => [shaOf(toExperience(r)), toExperience(r)]));
}

export interface ArmOptions {
  /** Total memories an arm may return. Both budgeted arms return at most this. */
  k: number;
  /** How many of arm B's K slots go to by-meaning hits before expansion. */
  seedCount: number;
  adjacency: Map<string, KnowledgeLink[]>;
  embedder?: EmbeddingProvider;
}

export async function byMeaningArm(question: string, options: ArmOptions): Promise<ArmResult> {
  const hits = await queryByMeaning(question, { limit: options.k, embedder: options.embedder });
  return {
    hits: hits.map((h) => ({
      experience: h.experience,
      shortSha: shaOf(h.experience),
      provenance: "by_meaning" as const,
    })),
    linksUsed: [],
  };
}

export async function linkedArm(question: string, options: ArmOptions): Promise<ArmResult> {
  // Ask for the full budget up front: ranks beyond `seedCount` are the backfill
  // pool, and asking twice would be a second query for the same rows.
  const ranked = await queryByMeaning(question, { limit: options.k, embedder: options.embedder });
  const seeds = ranked.slice(0, options.seedCount);
  const reserve = ranked.slice(options.seedCount);

  const chosen: ArmHit[] = seeds.map((h) => ({
    experience: h.experience,
    shortSha: shaOf(h.experience),
    provenance: "by_meaning" as const,
  }));
  const seen = new Set(chosen.map((h) => h.shortSha));

  const { hits: expanded, linksUsed } = await expandOneHop(
    seeds.map((h) => shaOf(h.experience)),
    options.adjacency,
    seen,
    options.k - chosen.length
  );
  chosen.push(...expanded);

  for (const h of reserve) {
    if (chosen.length >= options.k) break;
    const sha = shaOf(h.experience);
    if (seen.has(sha)) continue;
    seen.add(sha);
    chosen.push({ experience: h.experience, shortSha: sha, provenance: "backfill" });
  }

  return { hits: chosen, linksUsed };
}

/**
 * Control 1: identical to `linkedArm`, but only the two relations the hand-check
 * scored at 1.00 precision are traversed.
 *
 * If this matches `linkedArm`, the `follows_up` rule — which is 70% of all
 * mined edges and scored 0.00 on the labelled sample — contributes nothing and
 * should not be built.
 */
export async function strongLinkedArm(question: string, options: ArmOptions): Promise<ArmResult> {
  const strongOnly = new Map<string, KnowledgeLink[]>();
  for (const [sha, links] of options.adjacency) {
    const kept = links.filter((l) => l.relation !== "follows_up");
    if (kept.length > 0) strongOnly.set(sha, kept);
  }
  return linkedArm(question, { ...options, adjacency: strongOnly });
}

/**
 * Control 2: the same substitution, along **randomly rewired** edges.
 *
 * `linkedArm` beating `byMeaningArm` is only evidence for memory links if the
 * *identity* of the neighbour matters. This arm gives up by-meaning ranks
 * 4–5 for two arbitrary other memories, so if it wins too, the effect was
 * "any extra memory helps" and the mined relation is doing nothing. Rewiring
 * is seeded and preserves each seed's degree, so the budget spent is identical.
 */
export async function randomControlArm(
  question: string,
  options: ArmOptions,
  allShas: string[],
  seed: number
): Promise<ArmResult> {
  let state = (seed || 1) >>> 0;
  const next = (): number => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
  const rewired = new Map<string, KnowledgeLink[]>();
  for (const [sha, links] of options.adjacency) {
    rewired.set(
      sha,
      links.map((l) => ({
        ...l,
        from: sha,
        to: allShas[Math.floor(next() * allShas.length)] ?? sha,
      }))
    );
  }
  return linkedArm(question, { ...options, adjacency: rewired });
}

export async function unbudgetedArm(question: string, options: ArmOptions): Promise<ArmResult> {
  const base = await byMeaningArm(question, options);
  const seen = new Set(base.hits.map((h) => h.shortSha));
  const { hits: expanded, linksUsed } = await expandOneHop(
    base.hits.map((h) => h.shortSha),
    options.adjacency,
    seen,
    Number.POSITIVE_INFINITY
  );
  return { hits: [...base.hits, ...expanded], linksUsed };
}

/**
 * One hop out from `seedShas`, strongest edges first.
 *
 * Ordering is by link confidence and then by seed rank, which is the ranking a
 * real implementation would have to pick; it matters here because the budgeted
 * arm can only afford the first few. A neighbour with no recorded memory is
 * skipped — the edge exists in git, but there is nothing to put in the context.
 */
async function expandOneHop(
  seedShas: string[],
  adjacency: Map<string, KnowledgeLink[]>,
  seen: Set<string>,
  budget: number
): Promise<{ hits: ArmHit[]; linksUsed: KnowledgeLink[] }> {
  if (budget <= 0) return { hits: [], linksUsed: [] };

  const candidates: { sha: string; link: KnowledgeLink; seedRank: number }[] = [];
  seedShas.forEach((sha, seedRank) => {
    for (const link of adjacency.get(sha) ?? []) {
      const neighbour = otherEnd(link, sha);
      if (seen.has(neighbour)) continue;
      candidates.push({ sha: neighbour, link, seedRank });
    }
  });
  candidates.sort((a, b) => b.link.confidence - a.link.confidence || a.seedRank - b.seedRank);

  const memories = await memoriesForShas([...new Set(candidates.map((c) => c.sha))]);
  const hits: ArmHit[] = [];
  const linksUsed: KnowledgeLink[] = [];
  for (const candidate of candidates) {
    if (hits.length >= budget) break;
    if (seen.has(candidate.sha)) continue;
    const experience = memories.get(candidate.sha);
    // The edge is real but its other end never became a memory (a bare
    // `Revert "…"` body is below `isExplanatory`'s bar). Nothing to hydrate.
    if (!experience) continue;
    seen.add(candidate.sha);
    hits.push({ experience, shortSha: candidate.sha, provenance: "linked", via: candidate.link });
    linksUsed.push(candidate.link);
  }
  return { hits, linksUsed };
}

/**
 * Renders an arm's result the way `eval/why-spike` renders its context: the
 * lesson text, not a list of paths. Identical shape for every arm, so the
 * agent comparison differs only in *which* memories it is handed.
 */
export function renderContext(result: ArmResult, repoRoot: string): string {
  if (result.hits.length === 0) return "(no prior knowledge recorded for this area)";
  return result.hits
    .map((h, i) => {
      const e = h.experience;
      const where = e.relatedNodes.length ? ` · touched ${e.relatedNodes.length} file(s)` : "";
      const how = h.via ? ` · linked (${h.via.relation}) from an earlier hit` : "";
      const body = (e.lessons?.[0] ?? e.observation).trim();
      return `--- prior knowledge ${i + 1} (${e.action ?? "unknown source"}${where}${how}, confidence ${e.confidence}) ---\n${body}`;
    })
    .join("\n\n")
    .split(repoRoot)
    .join(".");
}
