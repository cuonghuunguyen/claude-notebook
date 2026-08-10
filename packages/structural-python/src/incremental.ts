import type { Node } from "@cognitive-memory/core";
import {
  appendEvent,
  getNodesByPath,
  getPool,
  markEdgesStaleForNode,
  markNodeDeleted,
} from "@cognitive-memory/graph-store";
import { extractProject } from "./extract.js";
import type { PythonProject } from "./project.js";
import { persistExtraction } from "./persist.js";

export interface IncrementalResult {
  upsertedNodes: number;
  upsertedEdges: number;
  deletedNodes: string[];
  staleEdges: number;
}

/**
 * spec.md §5/§21: incremental structural update for a set of changed Python
 * files. Same contract as packages/structural's extractChangedFiles: `project`
 * holds the full current repo (needed to resolve cross-file imports/calls
 * correctly), but only nodes/edges touching `changedFilePaths` get written.
 */
export async function extractChangedFiles(
  project: PythonProject,
  changedFilePaths: string[],
  repoId: string
): Promise<IncrementalResult> {
  const changedSet = new Set(changedFilePaths);
  const { nodes, edges } = extractProject(project, repoId);

  const nodesInChangedFiles = nodes.filter((n) => n.path && changedSet.has(n.path));
  const newIds = new Set(nodesInChangedFiles.map((n) => n.id));

  const toDelete: Node[] = [];
  for (const path of changedFilePaths) {
    const previous = await getNodesByPath(repoId, path);
    for (const old of previous) {
      if (!newIds.has(old.id)) toDelete.push(old);
    }
  }

  const deletedNodes: string[] = [];
  let staleEdges = 0;
  // One transaction for ALL of this call's deletions, not one per node — see
  // packages/structural's incremental.ts for the full rationale (this file is
  // a deliberate parallel copy of it, per spec.md §21's additive-extractors
  // design; the same fix applies identically here).
  if (toDelete.length > 0) {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      for (const old of toDelete) {
        await markNodeDeleted(old.id, client);
        await appendEvent({ eventType: "SymbolRemoved", payload: { id: old.id } }, client);
        staleEdges += await markEdgesStaleForNode(old.id, client);
        deletedNodes.push(old.id);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
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

  await persistExtraction(
    { nodes: nodesInChangedFiles, edges: edgesTouchingChangedFiles },
    repoId
  );

  return {
    upsertedNodes: nodesInChangedFiles.length,
    upsertedEdges: edgesTouchingChangedFiles.length,
    deletedNodes,
    staleEdges,
  };
}
