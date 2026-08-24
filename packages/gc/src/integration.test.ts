import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeDb,
  getDb,
  recordExperience,
  useTemporaryDatabase,
} from "@cognitive-memory/graph-store";
import { DEFAULT_TIER_THRESHOLDS } from "@cognitive-memory/tiers";
import { listIdleShortTermCandidates } from "./idleTier.js";
import { runGC } from "./run.js";


const DAY_MS = 24 * 60 * 60 * 1000;
const IDLE_DAYS = DEFAULT_TIER_THRESHOLDS.idleDays.short;

async function backdateTierClock(id: string, when: Date): Promise<void> {
  await getDb().query(
    `UPDATE experiences SET tier_changed_at = $1, last_accessed = NULL WHERE id = $2`,
    [when, id]
  );
}

async function makeShortTermMemory(daysIdle: number, now: Date): Promise<string> {
  const experience = await recordExperience({
    id: randomUUID(),
    task: `gc-idle-test-${randomUUID()}`,
    observation: "obs",
    relatedNodes: ["src/a.ts"],
    confidence: 0.7,
    timestamp: now.toISOString(),
  });
  await backdateTierClock(experience.id, new Date(now.getTime() - daysIdle * DAY_MS));
  return experience.id;
}

/**
 * §18 after M15.
 *
 * The three things this suite used to assert — nodes hard-deleted past a
 * 90-day window, invalidated edges past a 30-day one, and an experience marked
 * cold once every structural node it was bound to had a durable semantic edge
 * — all described rows that no longer exist. What §18 has left is M16's
 * retention signal, and the one behaviour worth pinning is that it is a
 * *report*: `runGC` must count an idle memory without hiding it, because
 * `cold` is a hard filter on every by-meaning leg and §24.5 forbids retrieval
 * missing a correct memory outright.
 */
describe("packages/gc integration (spec.md §18 / §24.5 retention signal)", () => {
  beforeAll(async () => {
    await useTemporaryDatabase();
  });

  afterAll(async () => {
    await closeDb();
  });

  it("counts a short-term memory idle past its window, and not one inside it", async () => {
    const now = new Date();
    const idle = await makeShortTermMemory(IDLE_DAYS + 1, now);
    const fresh = await makeShortTermMemory(1, now);

    const candidates = await listIdleShortTermCandidates(now);

    expect(candidates).toContain(idle);
    expect(candidates).not.toContain(fresh);
  });

  it("reports the count through runGC without marking anything cold (§24.5)", async () => {
    const now = new Date();
    const idle = await makeShortTermMemory(IDLE_DAYS + 1, now);

    const result = await runGC(now);

    expect(result.idleShortTermCandidates).toBeGreaterThanOrEqual(1);

    // The whole point: still warm, still retrievable by default. A GC pass
    // that quietly moved this memory out of the hot path would be the §24.5
    // violation `idleTier.ts` exists to refuse.
    // `cold` is INTEGER 0/1 (spec.md §25.5 — SQLite has no boolean type), and
    // this reads the raw column deliberately: the assertion is about what is
    // STORED, so decoding it through `rowToExperience` first would be asserting
    // on the decoder rather than on the GC pass.
    const { rows } = await getDb().query<{ cold: number; tier: string }>(
      `SELECT cold, tier FROM experiences WHERE id = $1`,
      [idle]
    );
    expect(rows[0]).toEqual({ cold: 0, tier: "short" });
  });
});
