/**
 * Exercises the git walk against real `git`, not a mock of it.
 *
 * `changedPathsSince` parses `git log --name-status -M` output; a fake would
 * only prove the parser agrees with the fake. Rename detection in particular is
 * a *git* behaviour (`-M` with a similarity threshold), so the only way to know
 * a `git mv` arrives as one `renamed` entry rather than a delete+add pair is to
 * make git produce it.
 *
 * Needs no database, so it is not `DATABASE_URL`-gated — it is named
 * `.integration.` because it shells out to a real tool, and it runs everywhere.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { matchAnchors, renameMapFrom } from "@cognitive-memory/core";
import { bulkyContent, buildFixtureRepo, type FixtureRepo } from "./fixtureRepo.js";
import { changedPathsSince, unquoteGitPath } from "./gitChanges.js";

const DATES = {
  init: "2026-01-01T00:00:00Z",
  edit: "2026-02-01T00:00:00Z",
  rename: "2026-03-01T00:00:00Z",
  editRenamed: "2026-04-01T00:00:00Z",
  remove: "2026-05-01T00:00:00Z",
};

let repo: FixtureRepo;
let repoDir: string;

beforeAll(async () => {
  repo = await buildFixtureRepo([
    {
      message: "initial",
      date: DATES.init,
      write: [
        { path: "src/parse.ts", content: bulkyContent("parse") },
        { path: "src/keep.ts", content: "export const keep = true;\n" },
        { path: "docs/notes.md", content: "notes\n" },
        // Paths git would quote or that break a naive split. Real anchors:
        // spec.md §24.2 point 7 promises this works for any file, and "any
        // file" includes an accented name and a name with a space.
        { path: "src/füü.ts", content: bulkyContent("accented") },
        { path: "src/with space.ts", content: bulkyContent("spaced") },
      ],
    },
    {
      message: "edit keep.ts",
      date: DATES.edit,
      write: [{ path: "src/keep.ts", content: "export const keep = true; // touched\n" }],
    },
    {
      message: "rename parse.ts -> parser.ts",
      date: DATES.rename,
      rename: [{ from: "src/parse.ts", to: "src/parser.ts" }],
    },
    {
      message: "edit the renamed file",
      date: DATES.editRenamed,
      write: [{ path: "src/parser.ts", content: bulkyContent("parse", 1) }],
    },
    { message: "remove notes", date: DATES.remove, remove: ["docs/notes.md"] },
  ]);
  repoDir = repo.dir;
});

afterAll(() => repo?.cleanup());

describe("changedPathsSince against real git", () => {
  it("reports a rename as ONE renamed entry, not a delete plus an add", async () => {
    const changes = await changedPathsSince({ repoDir });
    const renames = changes.filter((c) => c.kind === "renamed");
    expect(renames).toHaveLength(1);
    expect(renames[0]).toMatchObject({ path: "src/parser.ts", previousPath: "src/parse.ts" });

    // The negative half of the same claim: nothing anywhere calls the old path
    // deleted, which is what would happen without `-M`.
    expect(changes.some((c) => c.kind === "deleted" && c.path === "src/parse.ts")).toBe(false);
  });

  it("classifies added / modified / deleted", async () => {
    const changes = await changedPathsSince({ repoDir });
    const has = (path: string, kind: string) =>
      changes.some((c) => c.path === path && c.kind === kind);
    expect(has("src/parse.ts", "added")).toBe(true); // initial commit
    expect(has("src/keep.ts", "modified")).toBe(true);
    expect(has("docs/notes.md", "deleted")).toBe(true);
  });

  it("carries the commit sha and author date on every change", async () => {
    const changes = await changedPathsSince({ repoDir });
    expect(changes.length).toBeGreaterThan(0);
    for (const change of changes) {
      expect(change.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(Number.isNaN(Date.parse(change.date ?? ""))).toBe(false);
    }
  });

  it("emits newest commit first", async () => {
    const changes = await changedPathsSince({ repoDir });
    const dates = changes.map((c) => Date.parse(c.date ?? ""));
    expect(dates).toEqual([...dates].sort((a, b) => b - a));
  });

  it("--since bounds the walk", async () => {
    const changes = await changedPathsSince({ repoDir, since: DATES.editRenamed });
    // Only the last two commits (edit-the-renamed-file, remove-notes).
    expect(new Set(changes.map((c) => c.path))).toEqual(
      new Set(["src/parser.ts", "docs/notes.md"])
    );
  });

  it("an anchor on the pre-rename path is followed to the later edit", async () => {
    // M12's rename claim, end to end through real git output: a memory anchored
    // at `src/parse.ts` must still be reached by the commit that edited
    // `src/parser.ts` afterwards.
    const changes = await changedPathsSince({ repoDir });
    expect(renameMapFrom(changes).get("src/parse.ts")).toBe("src/parser.ts");

    const matched = matchAnchors([{ path: "src/parse.ts" }], changes);
    const kinds = matched.map((c) => `${c.kind}:${c.path}`);
    expect(kinds).toContain("modified:src/parser.ts");
    expect(kinds).toContain("renamed:src/parser.ts");
    expect(kinds).toContain("added:src/parse.ts");
  });

  it("a pathspec restricts the walk (and is therefore blind to the rename)", async () => {
    // Documents the trade-off `changedPathsSince` warns about, so the warning is
    // enforced rather than aspirational: scoping to the old path finds only
    // history from before the move.
    const changes = await changedPathsSince({ repoDir, paths: ["src/parse.ts"] });
    expect(
      changes.every((c) => c.path === "src/parse.ts" || c.previousPath === "src/parse.ts")
    ).toBe(true);
    expect(changes.some((c) => c.kind === "modified" && c.path === "src/parser.ts")).toBe(false);
  });

  it("reads a non-ASCII path back as its real name, not git's escaped form", async () => {
    // Without `core.quotePath=false` this arrives as
    // `"src/f\303\274\303\274.ts"` and matches no anchor — a silently
    // missed flag, which is the one failure mode §24.2.3 must not have.
    const changes = await changedPathsSince({ repoDir });
    const paths = changes.map((c) => c.path);
    expect(paths).toContain("src/füü.ts");
    expect(paths.some((p) => p.includes("\\303"))).toBe(false);
    expect(paths.some((p) => p.startsWith('"'))).toBe(false);
  });

  it("reads a path containing a space (tab-separated output, so it must survive)", async () => {
    const changes = await changedPathsSince({ repoDir });
    expect(changes.map((c) => c.path)).toContain("src/with space.ts");
  });

  it("an anchor on a non-ASCII path matches the change for it", async () => {
    const changes = await changedPathsSince({ repoDir });
    expect(matchAnchors([{ path: "src/füü.ts" }], changes)).toHaveLength(1);
  });

  it("returns nothing for a window with no commits", async () => {
    await expect(changedPathsSince({ repoDir, since: "2030-01-01T00:00:00Z" })).resolves.toEqual([]);
  });
});

describe("unquoteGitPath", () => {
  it("leaves an unquoted path alone", () => {
    expect(unquoteGitPath("src/parse.ts")).toBe("src/parse.ts");
    expect(unquoteGitPath("src/with space.ts")).toBe("src/with space.ts");
  });

  it("decodes multi-byte octal escapes as one UTF-8 character, not two", () => {
    expect(unquoteGitPath('"src/f\\303\\274\\303\\274.ts"')).toBe("src/füü.ts");
  });

  it("decodes the control-character escapes git keeps even with quotePath=false", () => {
    expect(unquoteGitPath('"src/ta\\tb.ts"')).toBe("src/ta\tb.ts");
    expect(unquoteGitPath('"a\\nb.ts"')).toBe("a\nb.ts");
  });

  it("decodes escaped quotes and backslashes", () => {
    expect(unquoteGitPath('"a\\"b.ts"')).toBe('a"b.ts');
    expect(unquoteGitPath('"a\\\\b.ts"')).toBe("a\\b.ts");
  });

  it("keeps an unknown escape's character rather than dropping it", () => {
    expect(unquoteGitPath('"a\\qb.ts"')).toBe("aqb.ts");
  });

  it("is not confused by a path that merely starts with a quote character", () => {
    expect(unquoteGitPath('"')).toBe('"');
  });
});
