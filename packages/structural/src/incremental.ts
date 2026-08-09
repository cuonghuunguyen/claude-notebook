import type { Project } from "ts-morph";
import {
  getNodesByPath,
  markEdgesStaleForNode,
  markNodeDeleted,
} from "@cognitive-memory/graph-store";
import { extractProject } from "./extract.js";
import { persistExtraction } from "./persist.js";

export interface IncrementalResult {
  upsertedNodes: number;
  upsertedEdges: number;
  deletedNodes: string[];
  staleEdges: number;
}

/**
 * spec.md §5: incremental structural update for a set of changed files.
 *
 * `project` must already contain the FULL current repo (ts-morph needs the
 * whole tree in memory to resolve cross-file calls/imports correctly — see
 * extract.ts). What stays incremental is what gets WRITTEN to graph-store:
 * only nodes whose path is one of `changedFilePaths`, plus edges touching
 * those nodes (an unrelated file's internal-only nodes/edges are recomputed
 * in memory but never persisted, since they didn't change). This is the
 * "don't rebuild the entire graph" guarantee spec.md §5 asks for — it's
 * about bounding what's written, not about avoiding an in-memory reparse
 * that correctness requires anyway.
 */
export async function extractChangedFiles(
  project: Project,
  changedFilePaths: string[],
  repoId: string
): Promise<IncrementalResult> {
  const changedSet = new Set(changedFilePaths);
  const { nodes, edges } = extractProject(project, repoId);

  const nodesInChangedFiles = nodes.filter((n) => n.path && changedSet.has(n.path));
  const newIds = new Set(nodesInChangedFiles.map((n) => n.id));

  const deletedNodes: string[] = [];
  let staleEdges = 0;
  for (const path of changedFilePaths) {
    const previous = await getNodesByPath(path);
    for (const old of previous) {
      if (!newIds.has(old.id)) {
        await markNodeDeleted(old.id);
        staleEdges += await markEdgesStaleForNode(old.id);
        deletedNodes.push(old.id);
      }
    }
  }

  const edgesTouchingChangedFiles = edges.filter((e) => {
    const fromNode = nodes.find((n) => n.id === e.from);
    const toNode = nodes.find((n) => n.id === e.to);
    return (
      (fromNode?.path && changedSet.has(fromNode.path)) ||
      (toNode?.path && changedSet.has(toNode.path))
    );
  });

  await persistExtraction({ nodes: nodesInChangedFiles, edges: edgesTouchingChangedFiles });

  return {
    upsertedNodes: nodesInChangedFiles.length,
    upsertedEdges: edgesTouchingChangedFiles.length,
    deletedNodes,
    staleEdges,
  };
}
