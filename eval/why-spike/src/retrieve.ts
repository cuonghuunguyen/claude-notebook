/**
 * Two ways of asking the memory a "why" question, run side by side.
 *
 * `nodeGated` is what the shipped system does (spec.md §17 + pipeline step 6):
 * retrieve code seeds, traverse, then hydrate experiences attached to exactly
 * those node ids. Knowledge is reachable only through the code — you must
 * already know *where* before you can learn *why*.
 *
 * `byMeaning` inverts it: the question is matched against the experience text
 * itself, and code binding is used to enrich and rank rather than to gate.
 * That is the change the spike is testing.
 *
 * Note this uses Postgres full-text ranking rather than embeddings: the
 * environment has no embedding API, and the shipped vector leg is a
 * hash-embedder stub. A real embedder should only help the `byMeaning` side,
 * so treating lexical rank as its floor keeps the comparison honest.
 */
import type { Experience } from "@cognitive-memory/core";
import { getPool } from "@cognitive-memory/graph-store";
import { runPipeline } from "@cognitive-memory/pipeline";
import { createFakeEmbedder } from "@cognitive-memory/retrieval";
import { createPostgresGraphProvider } from "@cognitive-memory/traversal";
import { REPO_ID } from "./config.js";

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is",
  "are", "was", "were", "be", "been", "it", "its", "that", "this", "why",
  "what", "how", "does", "do", "did", "when", "which", "who", "whom", "there",
  "then", "than", "so", "as", "at", "by", "from", "into", "instead", "rather",
  "not", "no", "any", "ever", "still", "just", "also", "would", "could",
  "should", "can", "will", "happened", "happens", "used", "use",
]);

/** OR-joined tsquery: a "why" question shares only a few terms with the commit that answers it. */
function toTsQuery(question: string): string {
  const terms = [
    ...new Set(
      question
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .split(/[^a-zA-Z0-9_]+/)
        .map((t) => t.toLowerCase())
        .filter((t) => t.length > 2 && !STOPWORDS.has(t))
    ),
  ];
  return terms.join(" | ");
}

export interface ScoredExperience {
  experience: Experience;
  rank: number;
  /** True when the experience is also bound to a node the traversal reached. */
  codeConfirmed: boolean;
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
  rank: number;
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

/** What the shipped design surfaces: experiences on exactly the traversed nodes. */
export async function nodeGated(question: string): Promise<ScoredExperience[]> {
  const { traversal } = await runPipeline(question, {
    repoId: REPO_ID,
    embedder: createFakeEmbedder(),
    graph: createPostgresGraphProvider(),
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
    `SELECT *, 0::real AS rank FROM experiences
      WHERE related_nodes ?| $1::text[]
      ORDER BY "timestamp" DESC LIMIT 10`,
    [traversal.nodeIds]
  );
  return rows.map((r) => ({ experience: toExperience(r), rank: 0, codeConfirmed: true }));
}

/** The flip: match the question against the knowledge itself. */
export async function byMeaning(question: string, limit = 5): Promise<ScoredExperience[]> {
  const tsquery = toTsQuery(question);
  if (!tsquery) return [];
  const { rows } = await getPool().query<Row>(
    `SELECT *,
            ts_rank(to_tsvector('english', task || ' ' || observation),
                    to_tsquery('english', $1)) AS rank
       FROM experiences
      WHERE to_tsvector('english', task || ' ' || observation) @@ to_tsquery('english', $1)
      ORDER BY rank DESC, "timestamp" DESC
      LIMIT $2`,
    [tsquery, limit]
  );
  return rows.map((r) => ({ experience: toExperience(r), rank: r.rank, codeConfirmed: false }));
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
