/**
 * Embedding storage and the vector leg's distance function (spec.md §25.3).
 *
 * There is no vector extension. §25.1 measured the alternative rather than
 * assuming it: brute-force cosine over 10,000 x 1536 Float32 vectors plus a
 * top-10 sort is 19 ms in plain JS, which is 300x the current corpus with no
 * index at all. pgvector's HNSW index was solving a problem this system does
 * not have, at the cost of the single hardest dependency in the stack — and it
 * served the leg `BENCHMARKS.md` measures as the weakest of the three (MRR 0.85
 * lexical-only vs 0.90 with the stub embedder).
 *
 * §25.7 names the ceiling this accepts: cosine here is O(n), so somewhere
 * around 10^5 memories the vector leg needs an index again. That is a named
 * trigger, not a solved problem.
 *
 * Float32 rather than Float64: it is what pgvector stored, so a corpus
 * re-embedded through this path gets bit-identical values rather than
 * silently more precise ones, and 1536 dims land in exactly 6144 bytes.
 */

/** Dimension every embedding in this system carries (migration 0001's `vector(1536)`). */
export const EMBEDDING_DIMENSIONS = 1536;

export function encodeEmbedding(embedding: readonly number[]): Buffer {
  const floats = new Float32Array(embedding.length);
  for (let i = 0; i < embedding.length; i += 1) floats[i] = embedding[i] as number;
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
}

export function decodeEmbedding(blob: Buffer | Uint8Array): Float32Array {
  // `Buffer.from(...)` copies, which matters: better-sqlite3 hands back a
  // Buffer over memory it owns, and a Float32Array view onto a non-8-aligned
  // offset throws. A copy is one 6 KB memcpy per candidate row.
  const copy = Buffer.from(blob);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

/**
 * Cosine similarity, the same convention the pgvector leg exposed: higher is
 * better (`1 - (a <=> b)`), not a distance.
 *
 * Returns 0 for a zero vector rather than NaN — a zero-norm embedding is a
 * degenerate write, and letting NaN into the score would sort
 * unpredictably instead of ranking last.
 *
 * A dimension mismatch throws, because pgvector's `<=>` did: with two
 * embedders in play (the real one and `createFakeEmbedder`) the realistic way
 * to get here is a corpus embedded by one being queried by the other, and
 * scoring the shared prefix would return a plausible number for vectors that
 * have nothing to do with each other — a silently wrong ranking instead of a
 * loud "re-embed the corpus".
 */
export function cosineSimilarity(
  a: readonly number[] | Float32Array,
  b: readonly number[] | Float32Array
): number {
  if (a.length !== b.length) {
    throw new Error(
      `cosine similarity needs equal dimensions, got ${a.length} and ${b.length} ` +
        `(a corpus embedded by a different embedder must be re-embedded, not compared)`
    );
  }
  const length = a.length;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i += 1) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}
