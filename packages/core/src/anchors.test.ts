import { describe, expect, it } from "vitest";
import {
  anchorPathHistory,
  anchorsFromRelatedNodes,
  changedPathUniverse,
  changeTouchesAnchor,
  dedupeAnchors,
  formatAnchor,
  isNodeId,
  isPossiblyStale,
  matchAnchors,
  newestChangeDate,
  parseAnchor,
  renameMapFrom,
  suspectReason,
  type Anchor,
  type ChangedPath,
} from "./anchors.js";
import { nodeId } from "./identity.js";

const change = (
  path: string,
  overrides: Partial<ChangedPath> = {}
): ChangedPath => ({ path, kind: "modified", ...overrides });

describe("anchor text form (spec.md §24.2.2)", () => {
  it("round-trips a path-only anchor", () => {
    expect(formatAnchor({ path: "src/parse.ts" })).toBe("src/parse.ts");
    expect(parseAnchor("src/parse.ts")).toEqual({ path: "src/parse.ts" });
  });

  it("round-trips a path#symbol anchor", () => {
    const anchor: Anchor = { path: "src/parse.ts", symbol: "parseAnchor" };
    expect(formatAnchor(anchor)).toBe("src/parse.ts#parseAnchor");
    expect(parseAnchor("src/parse.ts#parseAnchor")).toEqual(anchor);
  });

  it("splits on the LAST separator, so a '#' in the filename stays in the path", () => {
    expect(parseAnchor("docs/note#2.md#heading")).toEqual({
      path: "docs/note#2.md",
      symbol: "heading",
    });
  });

  it("treats a leading or trailing separator as part of the path, not an empty symbol", () => {
    expect(parseAnchor("src/parse.ts#")).toEqual({ path: "src/parse.ts#" });
    expect(parseAnchor("#weird")).toEqual({ path: "#weird" });
  });

  it("does NOT split a path that merely contains '#'", () => {
    // Regression guard: "text after the last #" is not enough to identify a
    // symbol, and a wrongly-split anchor points at a file that does not exist —
    // after which staleness silently never fires for that memory.
    expect(parseAnchor("docs/C#-notes.md")).toEqual({ path: "docs/C#-notes.md" });
    expect(parseAnchor("test/fixtures/issue#123.ts")).toEqual({
      path: "test/fixtures/issue#123.ts",
    });
    expect(parseAnchor("a/b#c d.ts")).toEqual({ path: "a/b#c d.ts" });
  });

  it("accepts a dotted symbol suffix", () => {
    expect(parseAnchor("src/a.ts#Class.method")).toEqual({
      path: "src/a.ts",
      symbol: "Class.method",
    });
    expect(parseAnchor("src/a.ts#_private$1")).toEqual({
      path: "src/a.ts",
      symbol: "_private$1",
    });
  });

  it("carries no line numbers — a path:line anchor stays one opaque path", () => {
    // spec.md §24.2.2: never line numbers. Nothing here parses `:412`, so a
    // caller that tries to smuggle one gets a path that matches no real file
    // rather than a silently half-working anchor.
    expect(parseAnchor("src/parse.ts:412")).toEqual({ path: "src/parse.ts:412" });
  });
});

describe("reading anchors out of a pre-M12 relatedNodes array", () => {
  it("keeps paths and drops structural node ids", () => {
    const id = nodeId("repo", "src/parse.ts#parseAnchor");
    expect(isNodeId(id)).toBe(true);
    expect(anchorsFromRelatedNodes(["src/parse.ts", id, "docs/spec.md"])).toEqual([
      { path: "src/parse.ts" },
      { path: "docs/spec.md" },
    ]);
  });

  it("parses the path#symbol form that M11 capture could already have written", () => {
    expect(anchorsFromRelatedNodes(["src/a.ts#foo"])).toEqual([
      { path: "src/a.ts", symbol: "foo" },
    ]);
  });

  it("leaves a legacy path containing '#' intact so it still matches its real file", () => {
    // This runs on EVERY pre-M12 memory via graph-store's row mapper, so a
    // mis-split here would quietly exempt those memories from staleness.
    expect(anchorsFromRelatedNodes(["docs/C#-notes.md"])).toEqual([
      { path: "docs/C#-notes.md" },
    ]);
  });

  it("ignores blank entries", () => {
    expect(anchorsFromRelatedNodes(["", "   ", "src/a.ts"])).toEqual([{ path: "src/a.ts" }]);
  });

  it("does not mistake a real path for a node id", () => {
    // 32 chars but not hex-only, and contains a slash.
    expect(isNodeId("packages/core/src/anchors/deadbeef")).toBe(false);
  });
});

describe("dedupeAnchors", () => {
  it("keeps first occurrence and treats path vs path#symbol as distinct", () => {
    expect(
      dedupeAnchors([
        { path: "a.ts" },
        { path: "a.ts" },
        { path: "a.ts", symbol: "x" },
      ])
    ).toEqual([{ path: "a.ts" }, { path: "a.ts", symbol: "x" }]);
  });
});

describe("anchor matching against a changed-paths list (M12 acceptance)", () => {
  it("matches a plain modification of the anchored path", () => {
    const matched = matchAnchors([{ path: "src/parse.ts" }], [
      change("src/parse.ts", { sha: "aaaa1111" }),
      change("src/other.ts", { sha: "aaaa1111" }),
    ]);
    expect(matched.map((c) => c.path)).toEqual(["src/parse.ts"]);
  });

  it("matches a file-level change even when the anchor names a symbol", () => {
    // M12's trigger is file-level on purpose: deciding whether the commit
    // touched THIS symbol needs a parser (spec.md §24.2 point 7).
    const matched = matchAnchors(
      [{ path: "src/parse.ts", symbol: "parseAnchor" }],
      [change("src/parse.ts")]
    );
    expect(matched).toHaveLength(1);
  });

  it("returns nothing when no anchored path was touched", () => {
    expect(matchAnchors([{ path: "src/parse.ts" }], [change("README.md")])).toEqual([]);
  });

  it("is empty for an unanchored memory and for an empty change list", () => {
    expect(matchAnchors([], [change("a.ts")])).toEqual([]);
    expect(matchAnchors([{ path: "a.ts" }], [])).toEqual([]);
  });

  // ---- the renamed-file case the acceptance criteria call out ----

  it("a rename commit matches the anchor still pointing at the OLD path", () => {
    const matched = matchAnchors(
      [{ path: "src/old.ts" }],
      [change("src/new.ts", { kind: "renamed", previousPath: "src/old.ts", sha: "bbbb2222" })]
    );
    expect(matched).toHaveLength(1);
    expect(matched[0]?.kind).toBe("renamed");
  });

  it("a LATER edit to the new path still resolves to the same anchor", () => {
    // The whole point of following renames: `git mv old new` then editing
    // `new` must keep flagging a memory anchored at `old`. Newest commit
    // first, as `git log` emits it.
    const changes = [
      change("src/new.ts", { sha: "cccc3333", date: "2026-03-03T00:00:00Z" }),
      change("src/new.ts", {
        kind: "renamed",
        previousPath: "src/old.ts",
        sha: "bbbb2222",
        date: "2026-02-02T00:00:00Z",
      }),
    ];
    const matched = matchAnchors([{ path: "src/old.ts" }], changes);
    expect(matched).toHaveLength(2);
    expect(matched.map((c) => c.sha)).toEqual(["cccc3333", "bbbb2222"]);
  });

  it("follows a multi-hop rename chain (a -> b -> c) back to the original anchor", () => {
    const changes = [
      change("c.ts", { sha: "3", date: "2026-03-03T00:00:00Z" }),
      change("c.ts", { kind: "renamed", previousPath: "b.ts", sha: "2", date: "2026-02-02T00:00:00Z" }),
      change("b.ts", { kind: "renamed", previousPath: "a.ts", sha: "1", date: "2026-01-01T00:00:00Z" }),
    ];
    expect(anchorPathHistory("a.ts", renameMapFrom(changes))).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(matchAnchors([{ path: "a.ts" }], changes)).toHaveLength(3);
  });

  it("does not treat a rename as a delete — the anchor is followed, not orphaned", () => {
    // A `deleted` change for the old path would be the wrong reading of
    // `git mv`; with -M git reports `renamed` and the anchor keeps working.
    const renamed = change("src/new.ts", { kind: "renamed", previousPath: "src/old.ts" });
    expect(changeTouchesAnchor(renamed, { path: "src/old.ts" })).toBe(true);
    expect(changeTouchesAnchor(renamed, { path: "src/new.ts" })).toBe(true);
  });

  it("terminates on a rename cycle within one window instead of looping forever", () => {
    const changes = [
      change("a.ts", { kind: "renamed", previousPath: "b.ts", sha: "2" }),
      change("b.ts", { kind: "renamed", previousPath: "a.ts", sha: "1" }),
    ];
    expect(anchorPathHistory("a.ts", renameMapFrom(changes)).sort()).toEqual(["a.ts", "b.ts"]);
  });

  it("an unrelated rename does not drag in an unrelated anchor", () => {
    const changes = [change("x/new.ts", { kind: "renamed", previousPath: "x/old.ts" })];
    expect(matchAnchors([{ path: "y/thing.ts" }], changes)).toEqual([]);
  });
});

describe("matchAnchors at scale (the rewritten path must stay correct and cheap)", () => {
  it("agrees with the pairwise predicate over a large change list", () => {
    // `matchAnchors` no longer calls `changeTouchesAnchor` per pair (it builds
    // one resolved path set instead), so pin the two against each other.
    const changes: ChangedPath[] = [];
    for (let i = 0; i < 2000; i += 1) {
      changes.push(change(`src/f${i}.ts`, { sha: `s${i}`, date: "2026-05-01T00:00:00Z" }));
    }
    changes.push(
      change("src/moved.ts", {
        kind: "renamed",
        previousPath: "src/origin.ts",
        sha: "ren",
        date: "2026-04-01T00:00:00Z",
      })
    );
    changes.push(change("src/moved.ts", { sha: "after", date: "2026-06-01T00:00:00Z" }));

    const anchors: Anchor[] = [{ path: "src/origin.ts" }, { path: "src/f7.ts" }];
    const renames = renameMapFrom(changes);
    const expected = changes.filter((c) =>
      anchors.some((a) => changeTouchesAnchor(c, a, renames))
    );
    expect(matchAnchors(anchors, changes)).toEqual(expected);
    expect(matchAnchors(anchors, changes).map((c) => c.sha).sort()).toEqual(
      ["after", "ren", "s7"].sort()
    );
  });

  it("stays well under a second for a 10k-change window", () => {
    // The regression this guards: the previous implementation allocated a Set
    // per (change, anchor) pair and measured ~20 ms for ONE memory here, which
    // is seconds per sync at a few hundred candidates.
    const changes: ChangedPath[] = Array.from({ length: 10_000 }, (_, i) =>
      change(`src/f${i}.ts`, { sha: `s${i}`, date: "2026-05-01T00:00:00Z" })
    );
    const anchors: Anchor[] = Array.from({ length: 10 }, (_, i) => ({ path: `src/f${i}.ts` }));
    const started = performance.now();
    for (let i = 0; i < 50; i += 1) matchAnchors(anchors, changes);
    const perCall = (performance.now() - started) / 50;
    expect(matchAnchors(anchors, changes)).toHaveLength(10);
    expect(perCall).toBeLessThan(10);
  });
});

describe("changedPathUniverse", () => {
  it("includes both sides of a rename, so the old path survives the storage prefilter", () => {
    const universe = changedPathUniverse([
      change("src/new.ts", { kind: "renamed", previousPath: "src/old.ts" }),
      change("README.md"),
    ]);
    expect(universe.sort()).toEqual(["README.md", "src/new.ts", "src/old.ts"]);
  });

  it("de-duplicates a path touched by several commits", () => {
    expect(changedPathUniverse([change("a.ts"), change("a.ts")])).toEqual(["a.ts"]);
  });
});

describe("staleness comparison (spec.md §24.2.3)", () => {
  const memory = "2026-02-01T12:00:00Z";

  it("commit newer than memory => flagged", () => {
    expect(isPossiblyStale(memory, "2026-02-01T12:00:01Z")).toBe(true);
    expect(isPossiblyStale(memory, "2026-06-01T00:00:00Z")).toBe(true);
  });

  it("memory newer than last commit => not flagged", () => {
    expect(isPossiblyStale(memory, "2026-01-31T23:59:59Z")).toBe(false);
    expect(isPossiblyStale(memory, "2025-01-01T00:00:00Z")).toBe(false);
  });

  it("a memory born from its own commit shares that timestamp and is NOT flagged", () => {
    // Capture writes the commit's date onto the mined memory, so equal
    // timestamps are the normal case for every git-mined memory. Strictly
    // newer is what stops the miner flagging everything it just wrote.
    expect(isPossiblyStale(memory, memory)).toBe(false);
  });

  it("no commit touching the anchors => not flagged", () => {
    expect(isPossiblyStale(memory, undefined)).toBe(false);
  });

  it("compares instants, not strings — a different offset for the same moment is not newer", () => {
    // "2026-02-01T13:00:00+01:00" is the same instant as the memory's 12:00Z,
    // but sorts after it as a string.
    expect(isPossiblyStale(memory, "2026-02-01T13:00:00+01:00")).toBe(false);
    expect(isPossiblyStale(memory, "2026-02-01T14:00:00+01:00")).toBe(true);
  });

  it("an unparseable date is not treated as newer", () => {
    expect(isPossiblyStale(memory, "not-a-date")).toBe(false);
    expect(isPossiblyStale("not-a-date", "2026-06-01T00:00:00Z")).toBe(false);
  });
});

describe("newestChangeDate", () => {
  it("picks the newest instant across mixed offsets", () => {
    expect(
      newestChangeDate([
        change("a", { date: "2026-01-01T00:00:00Z" }),
        change("b", { date: "2026-03-01T00:00:00+02:00" }),
        change("c", { date: "2026-02-01T00:00:00Z" }),
      ])
    ).toBe("2026-03-01T00:00:00+02:00");
  });

  it("is undefined when no change carries a date", () => {
    expect(newestChangeDate([change("a"), change("b")])).toBeUndefined();
    expect(newestChangeDate([])).toBeUndefined();
  });
});

describe("suspectReason", () => {
  it("names the change, the sha, and how many more there were", () => {
    expect(
      suspectReason([
        change("src/parse.ts", { sha: "a1b2c3d4e5f6" }),
        change("src/other.ts", { sha: "a1b2c3d4e5f6" }),
      ])
    ).toBe("modified src/parse.ts in a1b2c3d4 (+1 more)");
  });

  it("shows a rename as a move", () => {
    expect(
      suspectReason([change("new.ts", { kind: "renamed", previousPath: "old.ts", sha: "abcdef12" })])
    ).toBe("renamed old.ts -> new.ts in abcdef12");
  });

  it("degrades to the flag text when there is nothing to name", () => {
    expect(suspectReason([])).toContain("possibly-stale");
  });
});
