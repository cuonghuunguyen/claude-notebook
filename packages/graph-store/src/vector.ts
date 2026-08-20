/**
 * pgvector literal encoding, shared by every table that carries an
 * `embedding` column (`nodes` since migration 0001, `experiences` since
 * 0004). Lives in its own module rather than in `nodes.ts` so a second
 * table's vector leg doesn't have to duplicate it — the two must agree
 * byte-for-byte or the same embedder produces different distances depending
 * on which table it was written through.
 */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
