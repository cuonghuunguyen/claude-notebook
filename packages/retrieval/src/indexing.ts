import type { Node } from "@cognitive-memory/core";
import { upsertNodeEmbedding } from "@cognitive-memory/graph-store";
import type { EmbeddingProvider } from "./types.js";

/** What gets embedded for a node — name/path/summary/keywords, not the full source. */
export function nodeEmbeddingText(node: Node): string {
  return [node.name, node.path, node.summary, ...(node.metadata.keywords ?? [])]
    .filter(Boolean)
    .join(" ");
}

/**
 * Computes and persists embeddings for a batch of nodes via the injected
 * provider. Not part of extraction (packages/structural) — embedding
 * computation is retrieval's concern per spec.md ROADMAP M2, and only nodes
 * with meaningful text (name/path/summary/keywords) are worth embedding.
 */
export async function indexNodeEmbeddings(
  nodes: Node[],
  embedder: EmbeddingProvider
): Promise<void> {
  for (const node of nodes) {
    const text = nodeEmbeddingText(node);
    if (!text) continue;
    const embedding = await embedder.embed(text);
    await upsertNodeEmbedding(node.id, embedding);
  }
}
