import { describe, expect, it } from "vitest";
import { createFakeEmbedder } from "./embedding.js";

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot; // vectors are already unit-normalized
}

describe("createFakeEmbedder", () => {
  it("is deterministic — same text always embeds to the same vector", async () => {
    const embedder = createFakeEmbedder();
    const a = await embedder.embed("PaymentService");
    const b = await embedder.embed("PaymentService");
    expect(a).toEqual(b);
  });

  it("gives higher cosine similarity to token-overlapping text than to unrelated text", async () => {
    const embedder = createFakeEmbedder();
    const query = await embedder.embed("payment service charge");
    const related = await embedder.embed("PaymentService charge amount");
    const unrelated = await embedder.embed("formatDate iso timestamp");

    expect(cosine(query, related)).toBeGreaterThan(cosine(query, unrelated));
  });

  it("splits camelCase identifiers into tokens so PaymentService overlaps with payment/service", async () => {
    const embedder = createFakeEmbedder();
    const camel = await embedder.embed("PaymentService");
    const words = await embedder.embed("payment service");
    expect(cosine(camel, words)).toBeGreaterThan(0.5);
  });
});
