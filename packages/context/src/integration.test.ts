import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, runMigrations } from "@cognitive-memory/graph-store";
import { recordExperience } from "@cognitive-memory/episodic";
import { hydrateExperiences } from "./hydrate.js";

// Same DATABASE_URL-gating convention as every other integration suite in
// this repo — skipped, not failed, without a real Postgres.
const hasDb = Boolean(process.env["DATABASE_URL"]);
const d = hasDb ? describe : describe.skip;

d("packages/context hydrateExperiences integration", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await closePool();
  });

  it("fetches experiences touching any of the given nodes, deduped when one experience touches more than one", async () => {
    const nodeA = `node-${randomUUID()}`;
    const nodeB = `node-${randomUUID()}`;
    const unrelated = `node-${randomUUID()}`;

    const shared = await recordExperience({
      task: "context-test-shared",
      observation: "a fix that touched both nodeA and nodeB",
      relatedNodes: [nodeA, nodeB],
      confidence: 0.6,
    });
    const onlyA = await recordExperience({
      task: "context-test-only-a",
      observation: "a fix that only touched nodeA",
      relatedNodes: [nodeA],
      confidence: 0.6,
    });
    const irrelevant = await recordExperience({
      task: "context-test-unrelated",
      observation: "irrelevant to this subgraph",
      relatedNodes: [unrelated],
      confidence: 0.6,
    });

    const experiences = await hydrateExperiences([nodeA, nodeB]);
    const ids = experiences.map((e) => e.id);

    expect(ids).toContain(shared.id);
    expect(ids).toContain(onlyA.id);
    expect(ids.filter((id) => id === shared.id)).toHaveLength(1);
    expect(ids).not.toContain(irrelevant.id);
  });
});
