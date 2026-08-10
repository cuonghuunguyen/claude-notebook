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

  const deletedNodes: string[] = [];
  let staleEdges = 0;
  for (const path of changedFilePaths) {
    const previous = await getNodesByPath(repoId, path);
    for (const old of previous) {
      if (!newIds.has(old.id)) {
        const client = await getPool().connect();
        try {
          await client.query("BEGIN");
          await markNodeDeleted(old.id, client);
          await appendEvent({ eventType: "SymbolRemoved", payload: { id: old.id } }, client);
          staleEdges += await markEdgesStaleForNode(old.id, client);
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        } finally {
          client.release();
        }
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
