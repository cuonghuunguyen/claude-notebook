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

/**
 * Function words dropped before hashing. Same list `packages/episodic` drops
 * before building its full-text query, and for the same reason: they carry no
 * discriminating signal. Here they did worse than nothing — every prompt and
 * every commit body share them, so before this filter the cosine between an
 * unrelated question and the longest commit in a repository was ~0.6 (the
 * 2026-08-28 real-prompt replay, `BENCHMARKS.md`), which made the vector leg a
 * length detector rather than an overlap detector and left no score at which
 * "nothing relevant" could be told from "relevant".
 */
export const EMBED_STOPWORDS: ReadonlySet<string> = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is",
  "are", "was", "were", "be", "been", "it", "its", "that", "this", "why",
  "what", "how", "does", "do", "did", "when", "which", "who", "whom", "there",
  "then", "than", "so", "as", "at", "by", "from", "into", "instead", "rather",
  "not", "no", "any", "ever", "still", "just", "also", "would", "could",
  "should", "can", "will", "happened", "happens", "used", "use", "we", "our",
  "i", "you",
]);

function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9_]+/)
    .map((s) => s.toLowerCase())
    .filter((s) => s.length > 2 && !EMBED_STOPWORDS.has(s));
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
