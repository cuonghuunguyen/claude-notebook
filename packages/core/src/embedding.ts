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

/** The local sentence-embedding model, and the width it produces. */
export const LOCAL_EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";
export const LOCAL_EMBED_DIM = 384;

/** Loaded once per process — the ONNX session costs ~13 s cold and nothing after. */
let extractor:
  | Promise<(text: string[], options: object) => Promise<{ tolist(): number[][] }>>
  | undefined;

/**
 * Real sentence embeddings, on this machine, with no key and no daemon.
 *
 * Why this exists at all, since `createFakeEmbedder` was the shipped default
 * until 2026-09-03: feature-hashing gives cosine that tracks how RARE a
 * question's words are, not whether the corpus answers it, and the vector leg
 * is the one leg whose score is comparable across queries — so it is what any
 * relevance gate has to read. Measured on the same query against this repo's
 * corpus, hash vs. this model:
 *
 *   cos(question, the memory that answers it)   0.1937 -> 0.5554
 *   cos(question, an unrelated off-topic memory) 0.1865 -> -0.0178
 *
 * i.e. the hash embedder separated on-topic from off-topic by 0.007 and this
 * one separates them by 0.57. That gap is the whole reason the 2026-08-28
 * cosine floor could not be tuned to work (BENCHMARKS.md): there was no score
 * at which "nothing relevant" could be told from "relevant".
 *
 * `createFakeEmbedder` stays, and every test still uses it: it is
 * deterministic, needs no model, and keeps the suite offline and fast.
 */
export function createLocalEmbedder(model = LOCAL_EMBED_MODEL): EmbeddingProvider {
  return {
    async embed(text: string): Promise<number[]> {
      const { pipeline } = await import("@huggingface/transformers");
      extractor ??= pipeline("feature-extraction", model) as unknown as Promise<
        (text: string[], options: object) => Promise<{ tolist(): number[][] }>
      >;
      const run = await extractor;
      // Chunk before embedding. all-MiniLM-L6-v2 truncates at 256 wordpiece
      // tokens (~1,100 chars) and the pipeline does it SILENTLY, so a single
      // call on a long memory embeds its opening and discards the rest.
      // Measured on this repo's corpus: median memory 817 chars but p95
      // 11,149 and max 22,993, with 39% over the limit — i.e. the truncation
      // was landing on the longest, most information-dense memories, which are
      // exactly the ones worth retrieving.
      const chunks = chunkForEmbedding(text);
      const output = await run(chunks, { pooling: "mean", normalize: true });
      const vectors = output.tolist();
      const pooled = meanPool(vectors);
      if (!pooled) throw new Error(`local embedder returned no vector for ${text.slice(0, 40)}`);
      return pooled;
    },
  };
}

/** ~1,000 chars per chunk, split on whitespace so a chunk never starts mid-word. */
export const EMBED_CHUNK_CHARS = 1000;

export function chunkForEmbedding(text: string, size = EMBED_CHUNK_CHARS): string[] {
  if (text.length <= size) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      const boundary = text.lastIndexOf(" ", end);
      if (boundary > start) end = boundary;
    }
    chunks.push(text.slice(start, end));
    start = end;
    while (text[start] === " ") start++;
  }
  return chunks;
}

/** Average the chunk vectors and re-normalize, so one memory is still one vector. */
function meanPool(vectors: number[][]): number[] | undefined {
  const first = vectors[0];
  if (!first) return undefined;
  if (vectors.length === 1) return first;
  const summed = new Array<number>(first.length).fill(0);
  for (const vector of vectors) {
    for (let i = 0; i < summed.length; i++) summed[i] = (summed[i] ?? 0) + (vector[i] ?? 0);
  }
  let norm = 0;
  for (const value of summed) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  return summed.map((value) => value / norm);
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
