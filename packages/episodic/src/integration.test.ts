import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nodeId } from "@cognitive-memory/core";
import { closePool, getEdgeByTriple, getTierState, markExperienceCold, runMigrations, upsertNode } from "@cognitive-memory/graph-store";
import { settleSession } from "@cognitive-memory/tiers";
import { recordObservation } from "@cognitive-memory/semantic";
import { createFakeEmbedder } from "@cognitive-memory/retrieval";
import { upsertExperienceEmbedding } from "@cognitive-memory/graph-store";
import * as episodic from "./index.js";
import { queryByMeaning, queryByNode, queryByTask, recordExperience } from "./index.js";

describe("packages/episodic public API", () => {
  it("exposes no update or delete surface — spec.md §8 append-only is a package-boundary guarantee", () => {
    const exported = Object.keys(episodic);
    expect(exported).toContain("recordExperience");
    expect(exported).toContain("queryByNode");
    expect(exported).toContain("queryByTask");
    expect(exported).toContain("queryByMeaning");
    expect(exported.some((name) => /update|delete/i.test(name))).toBe(false);
  });
});

// Same DATABASE_URL-gating convention as every other integration suite in
// this repo — skipped, not failed, without a real Postgres.
const hasDb = Boolean(process.env["DATABASE_URL"]);
const d = hasDb ? describe : describe.skip;

d("packages/episodic integration", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await closePool();
  });

  it("round-trips a recorded experience through queryByNode and queryByTask", async () => {
    const task = `episodic-test-${randomUUID()}`;
    const nodeA = `node-${randomUUID()}`;
    const nodeB = `node-${randomUUID()}`;

    const recorded = await recordExperience({
      task,
      observation: "PaymentService.charge() threw on a null customerId",
      hypothesis: "charge() assumes customerId is always populated",
      action: "added a null-check and a regression test",
      result: "fixed; test now covers the null-customerId path",
      lessons: ["charge() must validate customerId before use"],
      relatedNodes: [nodeA, nodeB],
      confidence: 0.6,
    });

    expect(recorded.id).toBeTruthy();
    expect(recorded.timestamp).toBeTruthy();

    const byNode = await queryByNode(nodeA);
    expect(byNode.map((e) => e.id)).toContain(recorded.id);

    const byTask = await queryByTask(task);
    expect(byTask).toHaveLength(1);
    expect(byTask[0]).toEqual(recorded);
  });

  it("a repeatable lesson from a recorded experience feeds M3's promotion pipeline and reaches candidate", async () => {
    const repoId = `episodic-test-${randomUUID()}`;
    const fromId = nodeId(repoId, "src/paymentService.ts#PaymentService.charge");
    const toId = nodeId(repoId, "invariant:customerId-required");
    const now = new Date().toISOString();

    for (const id of [fromId, toId]) {
      await upsertNode(
        { id, type: "invariant", metadata: {}, provenance: [], status: "active", createdAt: now, updatedAt: now },
        repoId
      );
    }

    // A structural pass already recorded this constraint from source code.
    const first = await recordObservation(fromId, toId, "constrained_by", {
      sourceType: "source_code",
      sourceId: "src/paymentService.ts",
      confidence: 0.8,
      observedAt: now,
    });
    expect(first.promotion.stage).toBe("observation");

    // An agent independently hits the same constraint on a real task and
    // records what it learned — spec.md §8: an experience is just another
    // sourceType: "agent_experience" provenance record feeding §7's pipeline.
    const experience = await recordExperience({
      task: "fix-null-customerId-crash",
      observation: "charge() crashed when customerId was null",
      lessons: ["PaymentService.charge() requires a non-null customerId"],
      relatedNodes: [fromId, toId],
      confidence: 0.7,
    });

    const second = await recordObservation(fromId, toId, "constrained_by", {
      sourceType: "agent_experience",
      sourceId: experience.id,
      evidence: experience.lessons?.[0],
      confidence: experience.confidence,
      observedAt: experience.timestamp,
    });

    // Same table as packages/semantic's own tests: 2 observations from 2
    // distinct sourceTypes reach candidate, capped at 0.75.
    expect(second.promotion.stage).toBe("candidate");
    expect(second.promotion.confidence).toBeLessThanOrEqual(0.75);
    expect(second.edge.provenance).toHaveLength(2);

    const persisted = await getEdgeByTriple(fromId, toId, "constrained_by");
    expect(
      persisted?.provenance.some(
        (p) => p.sourceType === "agent_experience" && p.sourceId === experience.id
      )
    ).toBe(true);
  });
});

d("by-meaning retrieval (spec.md §24.2.1 / ROADMAP.md M11)", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await closePool();
  });

  it("finds a memory by what it says, with related_nodes empty — retrieval is not node-gated", async () => {
    const marker = randomUUID().replace(/-/g, "");
    const recorded = await recordExperience({
      task: `Why the ${marker} fastpass returns before assigning`,
      observation:
        `The ${marker} fastpass kept the parsed success value on the stack, so an early ` +
        `return from the optional-key branch discarded it and the caller saw undefined ` +
        `instead of the parsed object. Assigning before returning is the fix; re-walking ` +
        `the shape per optional key was the alternative and was measurably slower.`,
      lessons: ["assign before returning in the fastpass"],
      // The whole point: nothing to gate on.
      relatedNodes: [],
      confidence: 0.7,
    });

    // Paraphrased, not the recorded wording.
    const hits = await queryByMeaning(`what bug did the ${marker} early return cause`);

    const hit = hits.find((h) => h.experience.id === recorded.id);
    expect(
      hit,
      `expected the anchorless memory to be retrievable by meaning, got ${JSON.stringify(
        hits.map((h) => h.experience.task)
      )}`
    ).toBeDefined();
    expect(hit?.experience.relatedNodes).toEqual([]);
    expect(hit?.anchored).toBe(false);
  });

  it("puts a hit that both lexical legs and the vector leg agree on ahead of a single-leg hit", async () => {
    const marker = randomUUID().replace(/-/g, "");
    const embedder = createFakeEmbedder();

    const strong = await recordExperience({
      task: `${marker} prototype methods retain memory in v8`,
      observation:
        `Moving schema methods to the ${marker} prototype cut bundle size but made v8 ` +
        `retain more memory per instance, because inline slots no longer covered the ` +
        `method properties. The bundle win was judged worth the retained memory.`,
      relatedNodes: [],
      confidence: 0.7,
    });
    const weak = await recordExperience({
      task: `${marker} unrelated release chore`,
      observation:
        `Bumped the ${marker} version and regenerated the changelog. Nothing about ` +
        `prototypes, memory, or bundling changed in this commit at all whatsoever.`,
      relatedNodes: [],
      confidence: 0.7,
    });
    for (const e of [strong, weak]) {
      await upsertExperienceEmbedding(e.id, await embedder.embed(`${e.task} ${e.observation}`));
    }

    const hits = await queryByMeaning(
      `${marker} why do prototype methods make v8 retain more memory per instance`,
      { embedder, limit: 10 }
    );
    const ids = hits.map((h) => h.experience.id);
    expect(ids).toContain(strong.id);
    if (ids.includes(weak.id)) {
      expect(ids.indexOf(strong.id)).toBeLessThan(ids.indexOf(weak.id));
    }
    expect(hits.find((h) => h.experience.id === strong.id)?.legs.length).toBeGreaterThan(1);
  });

  it("returns nothing rather than throwing when the question is all stopwords", async () => {
    expect(await queryByMeaning("why is it that we do this")).toEqual([]);
  });

  it("honours spec.md §18's cold flag, and can be asked for cold knowledge explicitly", async () => {
    const marker = randomUUID().replace(/-/g, "");
    const recorded = await recordExperience({
      task: `${marker} anchor helper exists for esbuild tree shaking`,
      observation:
        `The ISO date regex is built through an ${marker} anchor helper rather than an ` +
        `inline template literal because esbuild will not treat an interpolated regex ` +
        `literal as pure, so the dead-code elimination pass kept the whole module.`,
      relatedNodes: [],
      confidence: 0.7,
    });
    const question = `${marker} why is the iso regex built through a helper`;

    expect((await queryByMeaning(question)).map((h) => h.experience.id)).toContain(recorded.id);

    await markExperienceCold(recorded.id);

    expect((await queryByMeaning(question)).map((h) => h.experience.id)).not.toContain(recorded.id);
    expect(
      (await queryByMeaning(question, { includeCold: true })).map((h) => h.experience.id)
    ).toContain(recorded.id);
  });

  it("persists the caller's timestamp, so a memory mined from history is dated by the history and not by the sync", async () => {
    const past = "2021-03-04T05:06:07.000Z";
    const recorded = await recordExperience({
      task: `timestamp-fidelity-${randomUUID()}`,
      observation: "A memory mined from a 2021 commit must not be dated today.",
      relatedNodes: [],
      confidence: 0.7,
      timestamp: past,
    });
    expect(recorded.timestamp).toBe(past);
    expect((await queryByTask(recorded.task))[0]?.timestamp).toBe(past);
  });
  it("performs write-on-read access accounting, and only sessions that REPORT using a memory promote it (spec.md §24.5)", async () => {
    const marker = `tiers-${randomUUID().slice(0, 8)}`;
    const recorded = await recordExperience({
      task: `${marker} why the settle step is separate from the retrieval step`,
      observation:
        `${marker}: access accounting lands provisional at retrieval time and is settled ` +
        `once the task outcome is known, because a retrieval on its own says nothing about ` +
        `whether the memory was correct.`,
      relatedNodes: [],
      confidence: 0.7,
      writerSession: `${marker}-writer`,
    });
    const question = `${marker} why is settle separate from retrieval`;

    // Anonymous retrieval: found, ranked, and accounted for by nothing.
    expect((await queryByMeaning(question)).map((h) => h.experience.id)).toContain(recorded.id);
    expect((await getTierState(recorded.id))?.accessCount).toBe(0);

    // Session one retrieves it through the shipped path — the accounting is a
    // side effect of real retrieval, not something a caller has to remember.
    const sessionOne = `${marker}-s1`;
    const hits = await queryByMeaning(question, { session: sessionOne });
    expect(hits.map((h) => h.experience.id)).toContain(recorded.id);
    expect(hits[0]?.tier).toBe("short");

    const afterRead = await getTierState(recorded.id);
    expect(afterRead?.accessCount).toBe(1);
    expect(afterRead?.lastAccessed).toBeTruthy();
    expect(afterRead?.tier).toBe("short"); // provisional buys nothing

    // A bare "the task passed" credits nothing (§24.5): the verdict describes
    // the task, not this memory. The session has to say what it relied on.
    await settleSession(sessionOne, "confirmed");
    expect((await getTierState(recorded.id))?.tier).toBe("short");
    expect((await getTierState(recorded.id))?.confirmedSessions).toBe(0);

    // Same session, now reporting use. Its accesses are already settled
    // `unused`, so a fresh session is what can still earn credit — which is
    // itself the point: credit is not retroactive.
    const sessionOneCiting = `${marker}-s1b`;
    await queryByMeaning(question, { session: sessionOneCiting });
    await settleSession(sessionOneCiting, "confirmed", { usedExperienceIds: [recorded.id] });
    expect((await getTierState(recorded.id))?.tier).toBe("mid");

    // Session two: a genuinely different session, so its confirmation is new
    // credit — but one more is not yet "sustained", so it stays mid-term.
    const sessionTwo = `${marker}-s2`;
    const secondHits = await queryByMeaning(question, { session: sessionTwo });
    expect(secondHits.find((h) => h.experience.id === recorded.id)?.tier).toBe("mid");
    await settleSession(sessionTwo, "confirmed", { usedExperienceIds: [recorded.id] });

    const settled = await getTierState(recorded.id);
    expect(settled).toMatchObject({ tier: "mid", confirmedSessions: 2 });

    // And the third distinct session is what earns long-term.
    const sessionThree = `${marker}-s3`;
    await queryByMeaning(question, { session: sessionThree });
    await settleSession(sessionThree, "confirmed", { usedExperienceIds: [recorded.id] });
    expect((await getTierState(recorded.id))?.tier).toBe("long");

    // The memory's own writer reading it back is neutral — no credit either way.
    await queryByMeaning(question, { session: `${marker}-writer` });
    expect((await getTierState(recorded.id))?.confirmedSessions).toBe(3);
  });
});
