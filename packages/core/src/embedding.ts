/**
 * The embedding-provider contract, and the deterministic stub every test in
 * the workspace embeds with.
 *
 * Lived in `packages/retrieval` until M15. That package existed to search the
 * structural graph (spec.md §9's hybrid lexical+vector node search feeding
 * §10's traversal) and retired with it — but the *injection* contract it
 * defined outlived its original subject: §24.2.1's by-meaning retrieval has a
 * vector leg of its own, over experience text rather than node text, and
 * `packages/capture` needs the same provider to embed a memory as it writes
 * it. So the interface moves here, to the package both of them already depend
 * on, rather than keeping a package alive around it.
 */
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

const DEFAULT_DIM = 1536;

/**
 * Deterministic fake embedder for tests and for the workspace's own eval
 * harnesses (spec.md ROADMAP M2: "stub with a deterministic fake embedder in
 * tests, real provider wired via config").
 *
 * Feature-hashes tokens into a fixed-width vector — not a real semantic
 * embedding, but deterministic and gives token-overlap-driven cosine
 * similarity, which is enough to exercise the vector leg without a live
 * embedding API. `BENCHMARKS.md` reports by-meaning MRR both with this stub
 * and without it for exactly that reason: the lexical-only number is the
 * honest floor.
 */
export function createFakeEmbedder(dim = DEFAULT_DIM): EmbeddingProvider {
  return {
    async embed(text: string): Promise<number[]> {
      return hashEmbed(text, dim);
    },
  };
}

function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((s) => s.toLowerCase());
}

function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function hashEmbed(text: string, dim: number): number[] {
  const vec = new Array<number>(dim).fill(0);
  for (const token of tokenize(text)) {
    const h = fnv1a(token);
    const idx = h % dim;
    const sign = h & 1 ? 1 : -1;
    vec[idx] = (vec[idx] ?? 0) + sign;
  }
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}
