import { describe, expect, it } from "vitest";
import {
  EMBEDDING_DIMENSIONS,
  cosineSimilarity,
  decodeEmbedding,
  encodeEmbedding,
} from "./vector.js";

describe("embedding storage (spec.md §25.3 — Float32 BLOB, no vector extension)", () => {
  it("round-trips 1536 dimensions in exactly 6144 bytes", () => {
    const embedding = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => i / 1000);
    const blob = encodeEmbedding(embedding);
    // The byte count is the whole of the storage contract, and it is what
    // `spec.md` §25.6 cites as the reason embeddings cannot live in frontmatter.
    expect(blob.byteLength).toBe(EMBEDDING_DIMENSIONS * 4);
    const decoded = decodeEmbedding(blob);
    expect(decoded).toHaveLength(EMBEDDING_DIMENSIONS);
    for (let i = 0; i < EMBEDDING_DIMENSIONS; i += 1) {
      expect(decoded[i]).toBeCloseTo(embedding[i] as number, 5);
    }
  });

  it("decodes a blob that better-sqlite3 handed back at an unaligned offset", () => {
    // Not hypothetical: better-sqlite3 returns a Buffer over memory it owns,
    // which is frequently a view into a larger pool at an offset that is not a
    // multiple of 4. `new Float32Array(buffer, byteOffset)` throws on such an
    // offset, which is why `decodeEmbedding` copies first.
    const source = encodeEmbedding([1, 2, 3]);
    const padded = Buffer.concat([Buffer.alloc(1), source]);
    const unaligned = padded.subarray(1);
    expect(unaligned.byteOffset % 4).not.toBe(0);
    expect([...decodeEmbedding(unaligned)]).toEqual([1, 2, 3]);
  });
});

describe("cosineSimilarity (the pgvector leg's `1 - (a <=> b)` convention)", () => {
  it("returns 1 for identical vectors and 0 for orthogonal ones", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 10);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  });

  it("is scale-invariant — it is a similarity, not a dot product", () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10);
  });

  it("returns 0 rather than NaN for a zero vector", () => {
    // A degenerate write must rank last, not sort unpredictably: NaN compares
    // false against everything, so a NaN score makes the leg's order depend on
    // the sort implementation.
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
  });

  it("throws on a dimension mismatch instead of scoring the shared prefix", () => {
    // pgvector's `<=>` raised here, and the mismatch is reachable rather than
    // theoretical: the workspace ships two embedders, so a corpus written by
    // one and queried by the other lands exactly here. Scoring the prefix
    // would produce a confident number for unrelated vectors.
    expect(() => cosineSimilarity([1, 2, 3], [1, 2])).toThrow(/equal dimensions/);
  });

  it("reads a Float32Array as happily as an array — the query side is not stored", () => {
    const stored = decodeEmbedding(encodeEmbedding([0.5, 0.25, 0.125]));
    expect(cosineSimilarity([0.5, 0.25, 0.125], stored)).toBeCloseTo(1, 6);
  });
});
