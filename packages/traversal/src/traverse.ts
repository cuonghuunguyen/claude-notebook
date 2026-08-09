import type { Edge, Node, TraversalBudget } from "@cognitive-memory/core";
import { DEFAULT_TRAVERSAL_BUDGET } from "@cognitive-memory/core";
import { scoreCandidate } from "./ranking.js";
import type {
  FrontierCandidate,
  TraversalResult,
  TraversalStopReason,
  TraverseOptions,
} from "./types.js";

/** spec.md §10's example cap: "top 15 candidates by §11 score" before a frontier reaches the reasoner. */
const DEFAULT_FRONTIER_CAP = 15;
/** A negative net score means traversal_cost already outweighs every relevance/importance signal — not worth a reasoning call. */
const DEFAULT_MIN_RELEVANCE_SCORE = 0;
/** Rough chars-per-token heuristic — good enough for budget enforcement, not a real tokenizer. */
const CHARS_PER_TOKEN_ESTIMATE = 4;

/**
 * Estimated token cost of adding one node+edge to the result (spec.md
 * §10.1's `maxTokens`). Only counts content traversal itself pulls in — the
 * seed set's own token cost is retrieval's (M2) concern, not traversal's.
 */
function estimateAdditionTokens(node: Node, edge: Edge): number {
  const text = `${node.name ?? ""} ${node.path ?? ""} ${node.summary ?? ""} ${edge.relation}`;
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

/**
 * seed nodes + task -> expanded subgraph (spec.md §10-§11). Reasoning runs
 * once per depth level over the whole ranked frontier, never once per edge
 * (spec.md §10's batching model) — one `graph.getFrontier` + one
 * `reasoner.decide` call per while-loop iteration, by construction.
 *
 * The frontier is tracked BFS-style: `frontier` holds only the nodes newly
 * added at the previous depth level, so each iteration fetches neighbors of
 * the boundary just reached, not of the whole visited set — the latter
 * would re-fetch and re-rank already-decided edges every level.
 */
export async function traverse(
  seedNodeIds: string[],
  task: string,
  options: TraverseOptions
): Promise<TraversalResult> {
  if (seedNodeIds.length === 0) {
    return { nodeIds: [], edges: [], depthReached: 0, reasoningStepsUsed: 0, stopReason: "no_frontier" };
  }

  const budget: TraversalBudget = { ...DEFAULT_TRAVERSAL_BUDGET, ...options.budget };
  const frontierCap = options.frontierCap ?? DEFAULT_FRONTIER_CAP;
  const minRelevanceScore = options.minRelevanceScore ?? DEFAULT_MIN_RELEVANCE_SCORE;

  const visited = new Set(seedNodeIds);
  const includedEdges = new Map<string, Edge>();
  let frontier = [...seedNodeIds];
  let depth = 0;
  let reasoningSteps = 0;
  let tokensUsed = 0;
  let stopReason: TraversalStopReason = "budget_exhausted";

  for (;;) {
    if (
      depth >= budget.maxDepth ||
      reasoningSteps >= budget.maxReasoningSteps ||
      visited.size >= budget.maxNodes ||
      includedEdges.size >= budget.maxEdges ||
      tokensUsed >= budget.maxTokens
    ) {
      stopReason = "budget_exhausted";
      break;
    }

    depth += 1;
    const rawFrontier = await options.graph.getFrontier(frontier, [...visited]);
    if (rawFrontier.length === 0) {
      // Nothing structurally exists at this level — it wasn't "reached" in
      // any meaningful sense, so don't count it toward depthReached.
      depth -= 1;
      stopReason = "no_frontier";
      break;
    }

    const neighborIds = [...new Set(rawFrontier.map((f) => f.neighborId))];
    const neighborNodes = await options.graph.getNodes(neighborIds);
    const nodesById = new Map(neighborNodes.map((n) => [n.id, n]));

    const scored = rawFrontier
      .filter((f) => nodesById.has(f.neighborId))
      .map((f) => {
        const node = nodesById.get(f.neighborId);
        if (!node) throw new Error(`unreachable: filtered for presence of ${f.neighborId}`);
        return {
          edge: f.edge,
          neighborId: f.neighborId,
          node,
          score: scoreCandidate({
            edge: f.edge,
            neighborNode: node,
            task,
            depth,
            taskEmbedding: options.taskEmbedding,
          }),
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, frontierCap);

    if (scored.length === 0) {
      // Every candidate neighbor was filtered out (e.g. all soft-deleted
      // since the edge was last written) — same as no_frontier, nothing was
      // actually evaluated at this level, so it doesn't count toward
      // depthReached either.
      depth -= 1;
      stopReason = "no_frontier";
      break;
    }
    if ((scored[0]?.score ?? -Infinity) < minRelevanceScore) {
      stopReason = "low_relevance";
      break;
    }

    reasoningSteps += 1;
    const candidates: FrontierCandidate[] = scored.map((c) => ({
      edgeId: c.edge.id,
      relation: c.edge.relation,
      neighborNodeId: c.neighborId,
      score: c.score,
    }));

    const result = await options.reasoner.decide({
      task,
      depth,
      visitedNodeIds: [...visited],
      candidates,
      budget,
    });

    const decisionByEdge = new Map(result.decisions.map((d) => [d.edgeId, d.action]));
    const nextFrontier: string[] = [];
    for (const c of scored) {
      if (
        visited.size >= budget.maxNodes ||
        includedEdges.size >= budget.maxEdges ||
        tokensUsed >= budget.maxTokens
      ) {
        break;
      }
      if (decisionByEdge.get(c.edge.id) !== "expand") continue;
      if (visited.has(c.neighborId)) continue; // two edges in this batch can reach the same neighbor
      visited.add(c.neighborId);
      includedEdges.set(c.edge.id, c.edge);
      tokensUsed += estimateAdditionTokens(c.node, c.edge);
      nextFrontier.push(c.neighborId);
    }
    frontier = nextFrontier;

    if (result.stop) {
      stopReason = "reasoner_stop";
      break;
    }
    if (frontier.length === 0) {
      stopReason = "no_expansion";
      break;
    }
  }

  return {
    nodeIds: [...visited],
    edges: [...includedEdges.values()],
    depthReached: depth,
    reasoningStepsUsed: reasoningSteps,
    stopReason,
  };
}
