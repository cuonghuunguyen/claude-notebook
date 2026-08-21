/**
 * How this harness asks the memory a "why" question.
 *
 * Until M15 there were two arms. `nodeGated` was what the system shipped
 * before M11 (spec.md §17 + the old pipeline step 6): retrieve code seeds,
 * traverse the symbol graph, then hydrate only the experiences attached to
 * exactly those node ids — knowledge reachable only *through* the code, so you
 * had to already know where before you could learn why. `byMeaning` inverts
 * it: the question is matched against the experience text itself.
 *
 * The node-gated arm is gone because M15's gate measured it out of existence.
 * On this corpus, over the ten questions below, it found the answering commit
 * 0 times out of 10 — with 501 extracted nodes and 1171 edges in the database,
 * and again with none — while by-meaning scored MRR 0.85 in both conditions.
 * There is no structural graph left to run the arm against, and `BENCHMARKS.md`
 * records the numbers it scored on its way out.
 *
 * The vector leg is left off by default (`SPIKE_EMBEDDER=fake` turns it on):
 * the environment has no embedding API and the workspace's only provider is a
 * feature-hashing stub, so lexical rank is treated as the by-meaning floor —
 * a real embedder should only help, which keeps the comparison honest.
 */
import type { Experience } from "@cognitive-memory/core";
import { createFakeEmbedder } from "@cognitive-memory/core";
import { queryByMeaning, type ScoredExperience as MeaningHit } from "@cognitive-memory/episodic";

export interface ScoredExperience {
  experience: Experience;
  rank: number;
  /** True when the experience carries any anchor (a text path since §24.2.2). */
  anchored: boolean;
}

/** Opt-in vector leg — see the file header. */
const embedder = process.env["SPIKE_EMBEDDER"] === "fake" ? createFakeEmbedder() : undefined;

/** Match the question against the knowledge itself — the shipped package path. */
export async function byMeaning(question: string, limit = 5): Promise<ScoredExperience[]> {
  const hits: MeaningHit[] = await queryByMeaning(question, { limit, embedder });
  return hits.map((h) => ({
    experience: h.experience,
    rank: h.score,
    anchored: h.anchored,
  }));
}

/**
 * Renders what the agent is handed: the lesson text itself, not a list of
 * file paths. Paths are repo-relative — the e2e benchmark found that absolute
 * ingest-time paths lead an agent to edit outside its own checkout.
 */
export function renderWhyContext(hits: ScoredExperience[], repoRoot: string): string {
  if (hits.length === 0) return "(no prior knowledge recorded for this area)";
  return hits
    .map((h, i) => {
      const e = h.experience;
      const where = e.relatedNodes.length
        ? ` · touched ${e.relatedNodes.length} file(s)`
        : "";
      const body = (e.lessons?.[0] ?? e.observation).trim();
      return `--- prior knowledge ${i + 1} (${e.action ?? "unknown source"}${where}, confidence ${e.confidence}) ---\n${body}`;
    })
    .join("\n\n")
    .split(repoRoot)
    .join(".");
}
