/**
 * Two ways of asking the memory a "why" question, run side by side.
 *
 * `nodeGated` is what the system shipped before M11 (spec.md §17 + pipeline
 * step 6): retrieve code seeds, traverse, then hydrate experiences attached to
 * exactly those node ids. Knowledge is reachable only through the code — you
 * must already know *where* before you can learn *why*.
 *
 * `byMeaning` inverts it: the question is matched against the experience text
 * itself, and code binding is used to enrich and rank rather than to gate.
 *
 * As of M11 this file no longer *implements* either side. `byMeaning` calls the
 * shipped `queryByMeaning` from `packages/episodic`, and `nodeGated` disables
 * it in `runPipeline` to reproduce the pre-M11 behaviour. That is the point of
 * the milestone: the number this harness reports is now a property of the
 * product, not of the spike.
 *
 * The vector leg is left off by default (`SPIKE_EMBEDDER=fake` turns it on):
 * the environment has no embedding API and the workspace's only provider is a
 * feature-hashing stub, so lexical rank is treated as the by-meaning floor —
 * a real embedder should only help, which keeps the comparison honest.
 */
import type { Experience } from "@cognitive-memory/core";
import { queryByMeaning, type ScoredExperience as MeaningHit } from "@cognitive-memory/episodic";
import { getPool } from "@cognitive-memory/graph-store";
import { runPipeline } from "@cognitive-memory/pipeline";
import { createFakeEmbedder } from "@cognitive-memory/retrieval";
import { createPostgresGraphProvider } from "@cognitive-memory/traversal";
import { REPO_ID } from "./config.js";

export interface ScoredExperience {
  experience: Experience;
  rank: number;
  /** True when the experience carries any anchor (a node id, or a text path since §24.2.2). */
  anchored: boolean;
}

interface Row {
  id: string;
  task: string;
  observation: string;
  action: string | null;
  lessons: string[];
  related_nodes: string[];
  confidence: number;
  timestamp: Date;
}

const toExperience = (r: Row): Experience => ({
  id: r.id,
  task: r.task,
  observation: r.observation,
  action: r.action ?? undefined,
  lessons: r.lessons,
  relatedNodes: r.related_nodes,
  confidence: r.confidence,
  timestamp: r.timestamp.toISOString(),
});

/** Opt-in vector leg — see the file header. */
const embedder = process.env["SPIKE_EMBEDDER"] === "fake" ? createFakeEmbedder() : undefined;

/** What the system surfaced before M11: experiences on exactly the traversed nodes. */
export async function nodeGated(question: string): Promise<ScoredExperience[]> {
  const { traversal } = await runPipeline(question, {
    repoId: REPO_ID,
    embedder: createFakeEmbedder(),
    graph: createPostgresGraphProvider(),
    // The whole point of this arm: reproduce the pre-M11 node-gated path.
    byMeaning: false,
    reasoner: {
      async decide(ctx) {
        return {
          decisions: ctx.candidates.map((c) => ({
            edgeId: c.edgeId,
            action: c.score >= 0.15 ? ("expand" as const) : ("skip" as const),
          })),
          stop: false,
        };
      },
    },
  });
  if (traversal.nodeIds.length === 0) return [];
  const { rows } = await getPool().query<Row>(
    `SELECT id, task, observation, action, lessons, related_nodes, confidence, "timestamp"
       FROM experiences
      WHERE related_nodes ?| $1::text[]
      ORDER BY "timestamp" DESC LIMIT 10`,
    [traversal.nodeIds]
  );
  return rows.map((r) => ({ experience: toExperience(r), rank: 0, anchored: true }));
}

/** The flip, now the shipped package path: match the question against the knowledge itself. */
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
        ? ` · touched ${e.relatedNodes.length} indexed file(s)`
        : "";
      const body = (e.lessons?.[0] ?? e.observation).trim();
      return `--- prior knowledge ${i + 1} (${e.action ?? "unknown source"}${where}, confidence ${e.confidence}) ---\n${body}`;
    })
    .join("\n\n")
    .split(repoRoot)
    .join(".");
}
