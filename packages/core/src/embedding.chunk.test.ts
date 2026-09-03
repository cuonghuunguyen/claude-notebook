import { describe, expect, it } from "vitest";
import { chunkForEmbedding, EMBED_CHUNK_CHARS } from "./embedding.js";

/**
 * `chunkForEmbedding` exists because all-MiniLM-L6-v2 truncates at 512
 * wordpiece tokens SILENTLY — 34 of 145 memories (23.4%) in this repo's own
 * corpus were over the limit when it was measured by tokenizing them
 * (BENCHMARKS.md 2026-09-03), so the vector leg was describing only the
 * opening of the longest memories. The model itself is not
 * exercised here: the suite stays offline and every other test embeds with
 * `createFakeEmbedder`. This covers the splitting, which is the part that can
 * silently lose text.
 */
describe("chunkForEmbedding", () => {
  it("leaves text at or under the limit as a single chunk", () => {
    expect(chunkForEmbedding("short body")).toEqual(["short body"]);
    const exact = "a".repeat(EMBED_CHUNK_CHARS);
    expect(chunkForEmbedding(exact)).toEqual([exact]);
  });

  it("never emits a chunk over the limit", () => {
    const text = Array.from({ length: 900 }, (_, i) => `word${i}`).join(" ");
    for (const chunk of chunkForEmbedding(text)) {
      expect(chunk.length).toBeLessThanOrEqual(EMBED_CHUNK_CHARS);
    }
  });

  it("loses no words — the whole body reaches the model, which is the entire point", () => {
    const words = Array.from({ length: 1500 }, (_, i) => `w${i}`);
    const text = words.join(" ");
    const rejoined = chunkForEmbedding(text).join(" ").split(/\s+/).filter(Boolean);
    expect(rejoined).toEqual(words);
  });

  it("splits on whitespace, so no chunk starts or ends mid-word", () => {
    const text = Array.from({ length: 600 }, (_, i) => `token${i}`).join(" ");
    const chunks = chunkForEmbedding(text);
    const original = new Set(text.split(" "));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.startsWith(" ")).toBe(false);
      expect(chunk.endsWith(" ")).toBe(false);
      // Every token in a chunk is a whole token from the original — a chunk
      // boundary that landed mid-word would produce a token that is not.
      for (const token of chunk.split(" ")) expect(original.has(token)).toBe(true);
    }
  });

  it("terminates on a single unbroken token longer than the limit", () => {
    // No whitespace to split on: the loop must still advance rather than spin.
    const unbroken = "x".repeat(EMBED_CHUNK_CHARS * 3 + 17);
    const chunks = chunkForEmbedding(unbroken);
    expect(chunks.join("")).toBe(unbroken);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(EMBED_CHUNK_CHARS);
  });

  it("returns an empty body as a single empty chunk, which the model accepts", () => {
    // Named for what it does: it DOES emit a chunk. Verified against the real
    // model separately — embedding "" returns a finite unit vector, not NaN.
    expect(chunkForEmbedding("")).toEqual([""]);
  });

  it("treats newlines and tabs as boundaries, not just spaces", () => {
    // The bug this pins: a boundary search using lastIndexOf(" ") cut
    // newline-separated text mid-token at EVERY chunk edge, and commit bodies
    // — this corpus's entire content — wrap on newlines.
    for (const separator of ["\n", "\t", "\r\n"]) {
      const tokens = Array.from({ length: 600 }, (_, i) => `line${i}`);
      const chunks = chunkForEmbedding(tokens.join(separator));
      expect(chunks.length).toBeGreaterThan(1);
      const seen = new Set(chunks.flatMap((chunk) => chunk.split(/\s+/)).filter(Boolean));
      for (const token of seen) expect(tokens).toContain(token);
    }
  });

  it("never emits a whitespace-only chunk, however much whitespace it meets", () => {
    // The bug this pins: `" ".repeat(50) + body` produced a 49-space first
    // chunk. `meanPool` is unweighted, so that chunk counted for as much as a
    // chunk of real prose — it was a third of the memory's vector.
    for (const text of [
      `${" ".repeat(50)}${"a".repeat(2000)}`,
      `a b${"x".repeat(3000)}`,
      `${"\n".repeat(200)}${"word ".repeat(500)}`,
    ]) {
      for (const chunk of chunkForEmbedding(text)) {
        expect(chunk.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("never emits a near-empty chunk just because one space sits near the start", () => {
    const chunks = chunkForEmbedding(`a b${"x".repeat(3000)}`);
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.length).toBeGreaterThan(EMBED_CHUNK_CHARS / 2);
    }
  });
});
