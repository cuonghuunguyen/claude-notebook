/**
 * Integration coverage for spec.md §24.5's accounting, against real Postgres.
 *
 * The pure transition table is `policy.test.ts`'s job. What can only be
 * tested here is the part that lives in the schema: that an access is keyed by
 * (memory, session) so a chatty session cannot self-promote, that a settle is
 * durable across "sessions", and that the confirmed-session counter is
 * recomputed rather than drifting.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closePool,
  getPool,
  getTierDistribution,
  getTierState,
  listIdleShortTermExperienceIds,
  recordExperience,
  runMigrations,
} from "@cognitive-memory/graph-store";
import {
  applyTierDecisions,
  DEFAULT_TIER_THRESHOLDS,
  recordRetrievalAccess,
  runTierMaintenance,
  settleSession,
} from "./index.js";

const hasDb = Boolean(process.env["DATABASE_URL"]);
const d = hasDb ? describe : describe.skip;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * MS_PER_DAY);

/**
 * A memory with a unique body, so nothing here can collide with another
 * suite's rows.
 *
 * `capturedAt` backdates `tier_changed_at` — the clock the decay rules read —
 * rather than the experience's own `timestamp`, because those are genuinely
 * different things: `timestamp` is when the knowledge is *from* (a mined
 * commit's date), `tier_changed_at` is when the memory became available to
 * retrieve. Only the second one can make a memory idle.
 */
async function memory(options: { writerSession?: string; capturedAt?: Date } = {}) {
  const id = `tier-test-${randomUUID()}`;
  const saved = await recordExperience(
    {
      id,
      task: `tier accounting ${id}`,
      observation: `synthetic memory ${id} for spec.md §24.5 accounting`,
      lessons: [],
      relatedNodes: [],
      confidence: 0.7,
      timestamp: (options.capturedAt ?? new Date()).toISOString(),
    },
    undefined,
    { writerSession: options.writerSession }
  );
  if (options.capturedAt) {
    await getPool().query(`UPDATE experiences SET tier_changed_at = $2 WHERE id = $1`, [
      saved.id,
      options.capturedAt,
    ]);
  }
  return saved;
}

d("memory tiers — access accounting (spec.md §24.5)", () => {
  beforeAll(async () => {
    await runMigrations();
  });
  afterAll(async () => {
    await closePool();
  });

  it("lands captured memories in short-term with no access credit", async () => {
    const m = await memory();
    const state = await getTierState(m.id);
    expect(state).toMatchObject({
      tier: "short",
      accessCount: 0,
      confirmedSessions: 0,
      lastAccessed: null,
    });
  });

  it("records write-on-read raw counters, and promotes nothing until the session's outcome is known", async () => {
    const m = await memory();
    await recordRetrievalAccess([m.id], "session-A");

    const beforeSettle = await getTierState(m.id);
    // The raw counters §24.5 asks for are there...
    expect(beforeSettle?.accessCount).toBe(1);
    expect(beforeSettle?.lastAccessed).toBeTruthy();
    // ...and they bought exactly nothing. This is the whole point: an access
    // is provisional until the task it served is known to have gone well.
    expect(beforeSettle?.confirmedSessions).toBe(0);
    await applyTierDecisions({ ids: [m.id] });
    expect((await getTierState(m.id))?.tier).toBe("short");
  });

  it("promotes short -> mid once a DIFFERENT session confirms it, and the promotion survives across sessions", async () => {
    const m = await memory({ writerSession: "session-writer" });

    // Session 1 retrieves it and its task ends well.
    await recordRetrievalAccess([m.id], "session-one");
    const settled = await settleSession("session-one", "confirmed", {
      usedExperienceIds: [m.id],
    });
    expect(settled.settled).toEqual([m.id]);
    expect(settled.changes).toMatchObject([
      { id: m.id, from: "short", to: "mid", reason: "promoted_distinct_session" },
    ]);

    // Session 2 is a fresh process reading the same row — the promotion is in
    // the database, not in anybody's memory.
    const state = await getTierState(m.id);
    expect(state).toMatchObject({ tier: "mid", confirmedSessions: 1 });
  });

  it("does not let one chatty session promote a memory by retrieving it repeatedly", async () => {
    const m = await memory();
    for (let i = 0; i < 12; i++) await recordRetrievalAccess([m.id], "session-chatty");
    await settleSession("session-chatty", "confirmed", { usedExperienceIds: [m.id] });

    const state = await getTierState(m.id);
    // Twelve hits, one session, one credit — the (memory, session) primary key
    // is what makes this true rather than a rule someone has to remember.
    expect(state?.accessCount).toBe(12);
    expect(state?.confirmedSessions).toBe(1);

    // Twelve more hits from the same session buy no further credit, so it
    // cannot reach the mid -> long threshold on its own.
    for (let i = 0; i < 12; i++) await recordRetrievalAccess([m.id], "session-chatty");
    await settleSession("session-chatty", "confirmed", { usedExperienceIds: [m.id] });
    expect((await getTierState(m.id))?.confirmedSessions).toBe(1);
    await applyTierDecisions({ ids: [m.id] });
    expect((await getTierState(m.id))?.tier).toBe("mid");
  });

  it("does not let a memory's own writer session promote it", async () => {
    const writer = `session-${randomUUID()}`;
    const m = await memory({ writerSession: writer });
    await recordRetrievalAccess([m.id], writer);
    const result = await settleSession(writer, "confirmed", { usedExperienceIds: [m.id] });

    // The access was recorded (`self`, neutral) and never became provisional,
    // so there was nothing for the settle to confirm.
    expect(result.settled).toEqual([]);
    expect((await getTierState(m.id))?.confirmedSessions).toBe(0);
    expect((await getTierState(m.id))?.accessCount).toBe(1);
  });

  it("climbs to long-term on sustained confirmed access from distinct sessions", async () => {
    const m = await memory();
    for (const session of ["s1", "s2", "s3"].map((s) => `${s}-${randomUUID()}`)) {
      await recordRetrievalAccess([m.id], session);
      await settleSession(session, "confirmed", { usedExperienceIds: [m.id] });
    }
    const state = await getTierState(m.id);
    expect(state?.confirmedSessions).toBe(3);
    // One promotion step per settle, and each step costs credit earned AFTER
    // the previous one: session 1 buys short -> mid, sessions 2 and 3 buy
    // mid -> long. Three distinct confirmed sessions is the real price of
    // long-term, not one confirmation counted twice.
    expect(state?.tier).toBe("long");
  });

  it("GATE: accesses from a failed task never count toward promotion, however many there are", async () => {
    const m = await memory();
    for (let i = 0; i < 5; i++) {
      const session = `failing-${i}-${randomUUID()}`;
      await recordRetrievalAccess([m.id], session);
      await settleSession(session, "rejected");
    }
    const state = await getTierState(m.id);
    expect(state?.accessCount).toBe(5);
    expect(state?.confirmedSessions).toBe(0);
    expect(state?.tier).toBe("short");
  });

  it("GATE: only the memories a passing task NAMES are confirmed; the rest stay neutral", async () => {
    const used = await memory();
    const ignored = await memory();
    const session = `partly-used-${randomUUID()}`;
    await recordRetrievalAccess([used.id, ignored.id], session);
    await settleSession(session, "confirmed", { usedExperienceIds: [used.id] });

    expect((await getTierState(used.id))?.tier).toBe("mid");
    expect((await getTierState(ignored.id))?.tier).toBe("short");
    expect((await getTierState(ignored.id))?.confirmedSessions).toBe(0);
    // Neutral, not negative: the ignored memory earns no credit but also
    // takes no blame, so it is not on a path to demotion either.
    expect((await getTierState(ignored.id))?.rejectedSinceCredit).toBe(0);
  });

  it("GATE: a passing task with no usage report promotes NOTHING, however many sessions", async () => {
    // The failure this closes: a task's pass/fail verdict describes the TASK,
    // not each memory it happened to retrieve. If a bare "confirmed" credited
    // everything retrieved, then a plausible-but-wrong memory returned
    // alongside nine right ones in three green tasks would reach long-term
    // without ever having helped anyone — raw access counting wearing a
    // gate's clothes, which is precisely what ROADMAP.md M16 calls an
    // automatic review failure.
    const m = await memory();
    for (let i = 0; i < 5; i++) {
      const session = `green-but-silent-${i}-${randomUUID()}`;
      await recordRetrievalAccess([m.id], session);
      await settleSession(session, "confirmed");
    }
    const state = await getTierState(m.id);
    expect(state?.accessCount).toBe(5);
    expect(state?.confirmedSessions).toBe(0);
    expect(state?.tier).toBe("short");
  });

  it("treats an EMPTY usage report the same as none — it must not mass-reject", async () => {
    // `[]` is a caller saying "I have no usage data", not "nothing was
    // useful". Settling those `rejected` would let a green task drive
    // demotions, which is a worse error than crediting nothing.
    const m = await memory();
    const session = `empty-usage-${randomUUID()}`;
    await recordRetrievalAccess([m.id], session);
    await settleSession(session, "confirmed", { usedExperienceIds: [] });

    const state = await getTierState(m.id);
    expect(state?.confirmedSessions).toBe(0);
    expect(state?.rejectedSinceCredit).toBe(0);
    expect(state?.tier).toBe("short");
  });

  it("credits every confirmation even when several settle in the same millisecond", async () => {
    // Consumption of credit is by sequence, not by timestamp. With a
    // timestamp predicate, a confirmation landing in the same millisecond as
    // the promotion it triggered was silently voided forever (tier_changed_at
    // never moves back), so long-term cost four confirmed sessions instead of
    // the three §24.5 states — non-deterministically, depending on clock
    // resolution.
    const m = await memory();
    const now = new Date();
    for (const s of ["a", "b", "c"].map((x) => `tie-${x}-${randomUUID()}`)) {
      await recordRetrievalAccess([m.id], s, { now });
      await settleSession(s, "confirmed", { usedExperienceIds: [m.id], now });
    }
    const state = await getTierState(m.id);
    expect(state?.confirmedSessions).toBe(3);
    expect(state?.tier).toBe("long");
  });

  it("demotes a memory that keeps being rejected after it earned a tier", async () => {
    const m = await memory();
    const good = `good-${randomUUID()}`;
    await recordRetrievalAccess([m.id], good);
    await settleSession(good, "confirmed", { usedExperienceIds: [m.id] });
    expect((await getTierState(m.id))?.tier).toBe("mid");

    for (let i = 0; i < DEFAULT_TIER_THRESHOLDS.rejectionsBeforeDemotion; i++) {
      const session = `bad-${i}-${randomUUID()}`;
      await recordRetrievalAccess([m.id], session);
      await settleSession(session, "rejected");
    }
    expect((await getTierState(m.id))?.tier).toBe("short");
  });

  it("leaves an unsettled session's accesses provisional forever — an abandoned task promotes nothing", async () => {
    const m = await memory();
    await recordRetrievalAccess([m.id], `abandoned-${randomUUID()}`);
    await runTierMaintenance();
    expect((await getTierState(m.id))?.tier).toBe("short");
  });

  it("decays an idle mid-term memory back to short-term and then makes it a GC candidate", async () => {
    const m = await memory({ capturedAt: daysAgo(500) });
    const session = `old-${randomUUID()}`;
    await recordRetrievalAccess([m.id], session, { now: daysAgo(300) });
    await settleSession(session, "confirmed", {
      usedExperienceIds: [m.id],
      now: daysAgo(300),
    });
    expect((await getTierState(m.id))?.tier).toBe("mid");

    const first = await runTierMaintenance();
    expect(first.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: m.id, from: "mid", to: "short", reason: "demoted_idle" }),
      ])
    );

    const second = await runTierMaintenance();
    expect(second.gcCandidates).toContain(m.id);
    // §18's own mechanism sees it too, and it is short-tier so it is eligible.
    const cutoff = new Date(Date.now() - DEFAULT_TIER_THRESHOLDS.idleDays.short * MS_PER_DAY);
    expect(await listIdleShortTermExperienceIds(cutoff)).toContain(m.id);
  });

  it("never offers a long-term memory as a GC candidate for coldness", async () => {
    const m = await memory({ capturedAt: daysAgo(500) });
    for (const tag of ["l1", "l2", "l3"]) {
      const session = `${tag}-${randomUUID()}`;
      await recordRetrievalAccess([m.id], session, { now: daysAgo(400) });
      await settleSession(session, "confirmed", {
        usedExperienceIds: [m.id],
        now: daysAgo(400),
      });
    }
    expect((await getTierState(m.id))?.tier).toBe("long");

    const result = await runTierMaintenance();
    expect(result.gcCandidates).not.toContain(m.id);
    // It decays a tier instead — long-term demotes, it just never disappears.
    expect(result.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: m.id, from: "long", to: "mid", reason: "demoted_idle" }),
      ])
    );
  });

  it("decays EVERY idle memory even when the corpus spans several scan pages", async () => {
    // The maintenance pass used to issue one SELECT under a default 100k cap,
    // so on a larger corpus everything past the cap silently never decayed and
    // nothing reported it. spec.md §18 says the experience log grows without
    // bound, so that is the expected steady state, not an edge case.
    //
    // Being precise about what this test can and cannot show: it does NOT
    // reproduce the old cap (that would need 100k rows). It pins the property
    // that made removing the cap safe — that the keyset scan visits EVERY page
    // rather than re-reading the first one or dropping the short final page.
    // A dropped cursor makes this loop forever; an off-by-one on the page
    // boundary drops rows, and 7 rows over pages of 2 puts a boundary in the
    // middle of the corpus and leaves the last page short.
    const idle = await Promise.all(
      Array.from({ length: 7 }, () => memory({ capturedAt: daysAgo(400) }))
    );
    for (const m of idle) {
      await getPool().query(`UPDATE experiences SET tier = 'mid' WHERE id = $1`, [m.id]);
    }

    // pageSize 2 over 7 rows = four pages, the last one short.
    const result = await runTierMaintenance({ pageSize: 2 });

    const demoted = new Set(
      result.changes.filter((c) => c.reason === "demoted_idle").map((c) => c.id)
    );
    for (const m of idle) {
      expect(demoted.has(m.id)).toBe(true);
      expect((await getTierState(m.id))?.tier).toBe("short");
    }
  });

  it("reports a tier distribution over the whole corpus", async () => {
    const distribution = await getTierDistribution();
    expect(Object.keys(distribution).sort()).toEqual(["long", "mid", "short"]);
    expect(distribution.short + distribution.mid + distribution.long).toBeGreaterThan(0);
  });
});
