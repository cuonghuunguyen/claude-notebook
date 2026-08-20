import type { Node } from "@cognitive-memory/core";
import type {
  AgentContext,
  BuildContextOptions,
  ExperienceSummary,
  InvariantSummary,
  RelationshipSummary,
  SourceFileSummary,
  Subgraph,
  SubsystemSummary,
} from "./types.js";

/** Caps chosen to keep the projection "compact" (spec.md §17) independent of whatever size subgraph a caller hands in — traversal's own budget (spec.md §10.1) is the primary size control, these are a second line of defense. */
const DEFAULT_MAX_SUBSYSTEMS = 10;
const DEFAULT_MAX_RELATIONSHIPS = 25;
const DEFAULT_MAX_INVARIANTS = 25;
/**
 * Exported because a caller assembling the subgraph has to know this number:
 * `buildContext` sorts experiences by recency before applying the cap, so a
 * caller that hands in MORE than this many relevance-ranked memories loses the
 * lowest-recency ones regardless of how relevant they were (spec.md §24.2.1's
 * by-meaning hits are ranked, not recent). `packages/pipeline` clamps its own
 * experience budget to this.
 */
export const DEFAULT_MAX_EXPERIENCES = 10;
const DEFAULT_MAX_SOURCE_FILES = 25;

function nodeLabel(node: Node): string {
  return node.name ?? node.path ?? node.id;
}

function labelFor(nodesById: Map<string, Node>, id: string): string {
  const node = nodesById.get(id);
  return node ? nodeLabel(node) : id;
}

function byLabel<T extends { name: string }>(a: T, b: T): number {
  return a.name.localeCompare(b.name);
}

/**
 * subgraph -> spec.md §17's compact, task-specific projection. Pure
 * templating over what's already in `subgraph` — no I/O, no LLM call (that's
 * the point of this milestone: the reasoning already happened in retrieval
 * (M2) and traversal (M5), this package only reshapes the result).
 */
export function buildContext(subgraph: Subgraph, task: string, options: BuildContextOptions = {}): AgentContext {
  const nodesById = new Map(subgraph.nodes.map((n) => [n.id, n]));

  // Nodes carry no relevance score of their own (unlike edges, which have
  // spec.md §3.3 weight/confidence) — `subgraph.nodes`' own order is the
  // best priority signal available, since a caller assembling it from
  // traversal (M5) encounters higher-ranked nodes first. So cap BEFORE
  // sorting: truncate on input order, then sort only the survivors
  // alphabetically for display, rather than sorting-then-truncating (which
  // would silently keep whichever entries sort earliest by name, regardless
  // of relevance).
  const subsystems: SubsystemSummary[] = subgraph.nodes
    .filter((n) => n.type === "subsystem")
    .slice(0, options.maxSubsystems ?? DEFAULT_MAX_SUBSYSTEMS)
    .map((n) => ({ nodeId: n.id, name: nodeLabel(n), summary: n.summary }))
    .sort(byLabel);

  const invariants: InvariantSummary[] = subgraph.nodes
    .filter((n) => n.type === "invariant")
    .slice(0, options.maxInvariants ?? DEFAULT_MAX_INVARIANTS)
    .map((n) => ({ nodeId: n.id, name: nodeLabel(n), summary: n.summary }))
    .sort(byLabel);

  const sourceFiles: SourceFileSummary[] = subgraph.nodes
    .filter((n) => n.type === "file")
    .slice(0, options.maxSourceFiles ?? DEFAULT_MAX_SOURCE_FILES)
    .map((n) => ({ nodeId: n.id, path: n.path ?? nodeLabel(n), summary: n.summary }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const relationships: RelationshipSummary[] = subgraph.edges
    .filter((e) => e.status !== "invalid")
    .map((e) => ({
      edgeId: e.id,
      relation: e.relation,
      from: { id: e.from, name: labelFor(nodesById, e.from) },
      to: { id: e.to, name: labelFor(nodesById, e.to) },
      confidence: e.confidence,
      weight: e.weight,
    }))
    .sort((a, b) => b.weight - a.weight || a.edgeId.localeCompare(b.edgeId))
    .slice(0, options.maxRelationships ?? DEFAULT_MAX_RELATIONSHIPS);

  const experiences: ExperienceSummary[] = [...(subgraph.experiences ?? [])]
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp) || a.id.localeCompare(b.id))
    .slice(0, options.maxExperiences ?? DEFAULT_MAX_EXPERIENCES)
    .map((e) => ({
      experienceId: e.id,
      task: e.task,
      lessons: e.lessons ?? [],
      result: e.result,
    }));

  return { task, subsystems, relationships, invariants, experiences, sourceFiles };
}
