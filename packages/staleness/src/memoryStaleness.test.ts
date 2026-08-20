import { describe, expect, it } from "vitest";
import { POSSIBLY_STALE_FLAG, type ChangedPath, type Experience } from "@cognitive-memory/core";
import { flagPossiblyStale } from "./memoryStaleness.js";

/**
 * These are unit tests, not integration tests, and that is a property of the
 * design rather than a shortcut: `flagPossiblyStale` accepts a pre-fetched
 * change list, so the verdict logic is exercised with no git process and no
 * database. The git walk that produces a real change list is covered by
 * `gitChanges.integration.test.ts`; the storage round trip by
 * `memoryStaleness.integration.test.ts`.
 */

const REPO = "/nonexistent-on-purpose";

function memory(overrides: Partial<Experience> = {}): Experience {
  return {
    id: overrides.id ?? "mem-1",
    task: "why does parse throw on empty input",
    observation: "because the tokenizer treats EOF as an error, see the revert in a1b2",
    relatedNodes: [],
    anchors: [{ path: "src/parse.ts" }],
    confidence: 0.7,
    timestamp: "2026-02-01T00:00:00Z",
    ...overrides,
  };
}

const change = (path: string, overrides: Partial<ChangedPath> = {}): ChangedPath => ({
  path,
  kind: "modified",
  date: "2026-03-01T00:00:00Z",
  sha: "deadbeef1234",
  ...overrides,
});

describe("flagPossiblyStale (spec.md §24.2.3)", () => {
  it("commit newer than the memory => flag present", async () => {
    const [verdict] = await flagPossiblyStale([memory()], {
      repoDir: REPO,
      changes: [change("src/parse.ts")],
    });
    expect(verdict?.possiblyStale).toBe(true);
    expect(verdict?.experience.suspect).toBe(true);
    expect(verdict?.reason).toBe("modified src/parse.ts in deadbeef");
    expect(verdict?.lastCommitDate).toBe("2026-03-01T00:00:00Z");
  });

  it("memory newer than the last commit => no flag", async () => {
    const [verdict] = await flagPossiblyStale(
      [memory({ timestamp: "2026-06-01T00:00:00Z" })],
      { repoDir: REPO, changes: [change("src/parse.ts")] }
    );
    expect(verdict?.possiblyStale).toBe(false);
    expect(verdict?.experience.suspect).toBeUndefined();
    expect(verdict?.reason).toBeUndefined();
  });

  it("a commit touching a path the memory is not anchored to => no flag", async () => {
    const [verdict] = await flagPossiblyStale([memory()], {
      repoDir: REPO,
      changes: [change("docs/README.md")],
    });
    expect(verdict?.possiblyStale).toBe(false);
  });

  it("flags through a rename, then through a later edit at the new path", async () => {
    const changes = [
      change("src/parser.ts", { sha: "cccc3333", date: "2026-04-01T00:00:00Z" }),
      change("src/parser.ts", {
        kind: "renamed",
        previousPath: "src/parse.ts",
        sha: "bbbb2222",
        date: "2026-03-01T00:00:00Z",
      }),
    ];
    const [verdict] = await flagPossiblyStale([memory()], { repoDir: REPO, changes });
    expect(verdict?.possiblyStale).toBe(true);
    // Both the rename and the later edit are attributed, newest first.
    expect(verdict?.changes).toHaveLength(2);
    expect(verdict?.reason).toBe("modified src/parser.ts in cccc3333 (+1 more)");
    expect(verdict?.lastCommitDate).toBe("2026-04-01T00:00:00Z");
  });

  it("returns one verdict per input, in input order, including unanchored memories", async () => {
    // §24.2.3 forbids silently dropping memories, and callers zip these back
    // together positionally — so the 1:1 correspondence is a contract.
    const inputs = [
      memory({ id: "stale" }),
      memory({ id: "unanchored", anchors: [] }),
      memory({ id: "fresh", timestamp: "2026-09-01T00:00:00Z" }),
    ];
    const verdicts = await flagPossiblyStale(inputs, {
      repoDir: REPO,
      changes: [change("src/parse.ts")],
    });
    expect(verdicts.map((v) => v.experience.id)).toEqual(["stale", "unanchored", "fresh"]);
    expect(verdicts.map((v) => v.possiblyStale)).toEqual([true, false, false]);
  });

  it("only the changes newer than the memory are attributed, not every anchor match", async () => {
    const changes = [
      change("src/parse.ts", { sha: "newer111", date: "2026-03-01T00:00:00Z" }),
      change("src/parse.ts", { sha: "older222", date: "2026-01-01T00:00:00Z" }),
    ];
    const [verdict] = await flagPossiblyStale([memory()], { repoDir: REPO, changes });
    expect(verdict?.changes.map((c) => c.sha)).toEqual(["newer111"]);
  });

  it("a memory recorded by the very commit that touched its path is not born stale", async () => {
    // Capture stamps the commit's own date onto the mined memory, so this is
    // the normal case for every git-mined memory — not an edge case.
    const [verdict] = await flagPossiblyStale(
      [memory({ timestamp: "2026-03-01T00:00:00Z" })],
      { repoDir: REPO, changes: [change("src/parse.ts", { date: "2026-03-01T00:00:00Z" })] }
    );
    expect(verdict?.possiblyStale).toBe(false);
  });

  it("a symbol-qualified anchor is still flagged by a file-level change", async () => {
    const [verdict] = await flagPossiblyStale(
      [memory({ anchors: [{ path: "src/parse.ts", symbol: "tokenize" }] })],
      { repoDir: REPO, changes: [change("src/parse.ts")] }
    );
    expect(verdict?.possiblyStale).toBe(true);
  });

  it("an empty input list does no work and spawns no git process", async () => {
    // `repoDir` points at nothing; if this tried to run git it would reject.
    await expect(flagPossiblyStale([], { repoDir: REPO })).resolves.toEqual([]);
  });

  it("never drops a flagged memory — it is returned, tagged", async () => {
    const verdicts = await flagPossiblyStale([memory()], {
      repoDir: REPO,
      changes: [change("src/parse.ts")],
    });
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.experience.observation).toBe(memory().observation);
    expect(POSSIBLY_STALE_FLAG).toContain("verify before trusting");
  });

  it("keeps a persisted suspect flag stale even when this window finds nothing newer", async () => {
    // The sync pass may have walked further back than the read path's `limit`.
    // Reporting possiblyStale:false while `buildContext` still renders the
    // persisted flag would make the two disagree about the same memory.
    const [verdict] = await flagPossiblyStale(
      [memory({ suspect: true, suspectReason: "modified src/parse.ts in aaaa1111" })],
      { repoDir: REPO, changes: [change("docs/unrelated.md")] }
    );
    expect(verdict?.possiblyStale).toBe(true);
    expect(verdict?.reason).toBe("modified src/parse.ts in aaaa1111");
    expect(verdict?.experience.suspect).toBe(true);
    // No change in THIS window matched, so there is nothing to re-check.
    expect(verdict?.changes).toEqual([]);
  });

  it("this window's own finding wins the reason over a stale persisted one", async () => {
    const [verdict] = await flagPossiblyStale(
      [memory({ suspect: true, suspectReason: "modified src/parse.ts in oldoldold" })],
      { repoDir: REPO, changes: [change("src/parse.ts")] }
    );
    expect(verdict?.reason).toBe("modified src/parse.ts in deadbeef");
  });

  it("an unsuspect memory with nothing newer stays clean", async () => {
    const [verdict] = await flagPossiblyStale([memory({ suspect: false })], {
      repoDir: REPO,
      changes: [change("docs/unrelated.md")],
    });
    expect(verdict?.possiblyStale).toBe(false);
    expect(verdict?.reason).toBeUndefined();
  });

  it("does not mutate the input experience", async () => {
    const input = memory();
    await flagPossiblyStale([input], { repoDir: REPO, changes: [change("src/parse.ts")] });
    expect(input.suspect).toBeUndefined();
  });
});
