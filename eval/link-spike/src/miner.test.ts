/**
 * Edge-miner unit tests (ROADMAP.md M14 acceptance point 1).
 *
 * Two levels, on purpose:
 *  - the three rules are exercised against **real fixture git repositories**
 *    built by `@cognitive-memory/capture/testing`, so `readCommitLog`'s parse
 *    and the rules agree with `git` itself rather than with a mock of it;
 *  - the guards (fanout caps, window edges, strongest-relation-wins) are
 *    exercised on hand-built `LinkCommit[]`, where a 40-commit hub can be
 *    stated in three lines instead of committed.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildFixtureRepo } from "@cognitive-memory/capture/testing";
import { describe, expect, it } from "vitest";
import {
  buildAdjacency,
  mineKnowledgeLinks,
  otherEnd,
  readCommitLog,
  type KnowledgeLink,
  type LinkCommit,
} from "./miner.js";

const execFileAsync = promisify(execFile);

const FIXTURE_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
};

/**
 * Appends one commit to an already-built fixture, which `buildFixtureRepo`
 * cannot express: a revert body has to quote a sha that does not exist until
 * the commit it reverts has been written.
 */
async function appendCommit(
  dir: string,
  commit: { subject: string; body: string; file: string; date: string }
): Promise<string> {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const absolute = join(dir, commit.file);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `// ${commit.subject}\n// ${commit.date}\n`);
  const env = { ...process.env, ...FIXTURE_ENV, GIT_AUTHOR_DATE: commit.date, GIT_COMMITTER_DATE: commit.date };
  await execFileAsync("git", ["add", "-A"], { cwd: dir, env });
  await execFileAsync(
    "git",
    ["commit", "--quiet", "--date", commit.date, "-m", commit.subject, "-m", commit.body],
    { cwd: dir, env }
  );
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir, env });
  return stdout.trim();
}

const commit = (over: Partial<LinkCommit> & { shortSha: string }): LinkCommit => ({
  sha: `${over.shortSha}${"0".repeat(40 - over.shortSha.length)}`,
  date: "2026-01-01T00:00:00Z",
  subject: `subject ${over.shortSha}`,
  body: "",
  files: [],
  ...over,
});

const find = (
  links: KnowledgeLink[],
  from: string,
  to: string
): KnowledgeLink | undefined => links.find((l) => l.from === from && l.to === to);

describe("readCommitLog", () => {
  it("returns every commit in scope, not just the explanatory ones", async () => {
    const repo = await buildFixtureRepo([
      { subject: "fix typo", body: "", files: ["src/a.ts"], date: "2026-01-01T00:00:00Z" },
      {
        subject: "explain something",
        body: "x".repeat(250),
        files: ["src/b.ts"],
        date: "2026-01-02T00:00:00Z",
      },
    ]);
    const commits = await readCommitLog(repo.dir, "src");
    // `packages/capture`'s miner would drop "fix typo"; the link miner must
    // not, because a revert of a terse commit is still a revert.
    expect(commits.map((c) => c.subject).sort()).toEqual(["explain something", "fix typo"]);
    expect(commits.every((c) => c.files.length === 1)).toBe(true);
  });

  it("drops a commit whose only in-scope files are tests, exactly as capture does", async () => {
    const repo = await buildFixtureRepo([
      {
        subject: "cover the regression",
        body: "y".repeat(250),
        files: ["src/tests/a.test.ts"],
        date: "2026-01-01T00:00:00Z",
      },
      { subject: "real change", body: "", files: ["src/a.ts"], date: "2026-01-02T00:00:00Z" },
    ]);
    const commits = await readCommitLog(repo.dir, "src");
    // If the miner saw a commit `packages/capture` never records, it would emit
    // edges whose other end can never be hydrated into a context.
    expect(commits.map((c) => c.subject)).toEqual(["real change"]);
  });

  it("restricts files to the mined path scope", async () => {
    const repo = await buildFixtureRepo([
      { subject: "touch both", body: "", files: ["src/a.ts", "docs/a.md"], date: "2026-01-01T00:00:00Z" },
    ]);
    const commits = await readCommitLog(repo.dir, "src");
    expect(commits).toHaveLength(1);
    expect(commits[0]?.files).toEqual(["src/a.ts"]);
  });
});

describe("mineKnowledgeLinks — reverts", () => {
  it("links a git-generated revert to the commit it reverts, over a real repo", async () => {
    const repo = await buildFixtureRepo([
      { subject: "reject whitespace in base64", body: "", files: ["src/a.ts"], date: "2026-01-01T00:00:00Z" },
      { subject: "unrelated", body: "", files: ["src/z.ts"], date: "2026-01-02T00:00:00Z" },
    ]);
    const originalSha = repo.shas[0]!;
    await appendCommit(repo.dir, {
      subject: 'Revert "reject whitespace in base64"',
      body: `This reverts commit ${originalSha}.`,
      file: "src/a.ts",
      date: "2026-01-03T00:00:00Z",
    });

    const links = mineKnowledgeLinks(await readCommitLog(repo.dir, "src"));
    const revert = links.find((l) => l.relation === "reverts");
    expect(revert).toBeDefined();
    expect(revert?.to).toBe(originalSha.slice(0, 8));
    expect(revert?.evidence).toContain("This reverts commit");
    expect(revert?.confidence).toBeGreaterThan(0.9);
  });

  it("resolves an abbreviated sha a human pasted by hand", () => {
    const target = commit({ shortSha: "aaaaaaaa", date: "2026-01-01T00:00:00Z" });
    const later = commit({
      shortSha: "bbbbbbbb",
      date: "2026-01-02T00:00:00Z",
      body: `This reverts commit ${target.sha.slice(0, 7)}.`,
    });
    const links = mineKnowledgeLinks([target, later]);
    expect(find(links, "bbbbbbbb", "aaaaaaaa")?.relation).toBe("reverts");
  });

  it("falls back to the subject form when the body names no sha", () => {
    const original = commit({ shortSha: "aaaaaaaa", subject: "add strict tuples", date: "2026-01-01T00:00:00Z" });
    const revert = commit({
      shortSha: "bbbbbbbb",
      subject: 'Revert "add strict tuples"',
      date: "2026-01-05T00:00:00Z",
    });
    const links = mineKnowledgeLinks([original, revert]);
    const link = find(links, "bbbbbbbb", "aaaaaaaa");
    expect(link?.relation).toBe("reverts");
    expect(link?.evidence).toContain("matches aaaaaaaa");
  });

  it("never links a commit to itself when its own body quotes its own sha", () => {
    const self = commit({ shortSha: "aaaaaaaa" });
    const withSelfRef = { ...self, body: `This reverts commit ${self.sha}.` };
    expect(mineKnowledgeLinks([withSelfRef])).toEqual([]);
  });

  it("ignores a revert of a commit outside the mined window", () => {
    const later = commit({
      shortSha: "bbbbbbbb",
      body: "This reverts commit 0123456789abcdef0123456789abcdef01234567.",
    });
    expect(mineKnowledgeLinks([later])).toEqual([]);
  });
});

describe("mineKnowledgeLinks — shares_issue", () => {
  it("links two commits citing the same issue, over a real repo", async () => {
    const repo = await buildFixtureRepo([
      {
        subject: "fix union error message (#4523)",
        body: "The bare invalid_union issue carried no message.",
        files: ["src/a.ts"],
        date: "2026-01-01T00:00:00Z",
      },
      {
        subject: "follow-up on unions",
        body: "Completes the work started in #4523; the first pass missed xor.",
        files: ["src/b.ts"],
        date: "2026-02-01T00:00:00Z",
      },
    ]);
    const links = mineKnowledgeLinks(await readCommitLog(repo.dir, "src"));
    const shared = links.find((l) => l.relation === "shares_issue");
    expect(shared).toBeDefined();
    expect(shared?.from).toBe(repo.shortShas[1]);
    expect(shared?.to).toBe(repo.shortShas[0]);
    expect(shared?.evidence).toContain("#4523");
  });

  it("reads the full GitHub URL form as the same reference as #N", () => {
    const a = commit({ shortSha: "aaaaaaaa", date: "2026-01-01T00:00:00Z", body: "closes #99" });
    const b = commit({
      shortSha: "bbbbbbbb",
      date: "2026-01-02T00:00:00Z",
      body: "see https://github.com/colinhacks/zod/issues/99 for the report",
    });
    expect(find(mineKnowledgeLinks([a, b]), "bbbbbbbb", "aaaaaaaa")?.relation).toBe("shares_issue");
  });

  it("drops a high-fanout reference: a tracking issue is a label, not a link", () => {
    const cited = Array.from({ length: 8 }, (_, i) =>
      commit({
        shortSha: `c${String(i).padStart(7, "0")}`,
        date: `2026-01-0${i + 1}T00:00:00Z`,
        body: "part of the v4 migration #1",
      })
    );
    expect(mineKnowledgeLinks(cited, { maxIssueFanout: 6 }).filter((l) => l.relation === "shares_issue")).toEqual([]);
    // The same corpus under a cap that admits it produces the full clique.
    expect(
      mineKnowledgeLinks(cited, { maxIssueFanout: 8 }).filter((l) => l.relation === "shares_issue")
    ).toHaveLength((8 * 7) / 2);
  });
});

describe("mineKnowledgeLinks — follows_up", () => {
  const onFile = (shortSha: string, date: string) =>
    commit({ shortSha, date, files: ["src/core.ts"] });

  it("links consecutive touches of one file inside the window", async () => {
    const repo = await buildFixtureRepo([
      { subject: "first", body: "", files: ["src/core.ts"], date: "2026-01-01T00:00:00Z" },
      { subject: "second", body: "", files: ["src/core.ts"], date: "2026-01-04T00:00:00Z" },
    ]);
    const links = mineKnowledgeLinks(await readCommitLog(repo.dir, "src"), { windowDays: 14 });
    const follow = links.find((l) => l.relation === "follows_up");
    expect(follow?.from).toBe(repo.shortShas[1]);
    expect(follow?.to).toBe(repo.shortShas[0]);
    expect(follow?.evidence).toContain("src/core.ts");
  });

  it("drops a pair that falls outside the window", () => {
    const links = mineKnowledgeLinks(
      [onFile("aaaaaaaa", "2026-01-01T00:00:00Z"), onFile("bbbbbbbb", "2026-03-01T00:00:00Z")],
      { windowDays: 14 }
    );
    expect(links).toEqual([]);
  });

  it("links adjacent pairs only, not the cross-product of a hot file", () => {
    const links = mineKnowledgeLinks(
      [
        onFile("aaaaaaaa", "2026-01-01T00:00:00Z"),
        onFile("bbbbbbbb", "2026-01-02T00:00:00Z"),
        onFile("cccccccc", "2026-01-03T00:00:00Z"),
      ],
      { windowDays: 14 }
    );
    expect(links).toHaveLength(2);
    expect(find(links, "bbbbbbbb", "aaaaaaaa")).toBeDefined();
    expect(find(links, "cccccccc", "bbbbbbbb")).toBeDefined();
    expect(find(links, "cccccccc", "aaaaaaaa")).toBeUndefined();
  });

  it("skips a file so hot it links everything to everything", () => {
    const commits = Array.from({ length: 5 }, (_, i) =>
      onFile(`d${String(i).padStart(7, "0")}`, `2026-01-0${i + 1}T00:00:00Z`)
    );
    expect(mineKnowledgeLinks(commits, { maxFileFanout: 4 })).toEqual([]);
    expect(mineKnowledgeLinks(commits, { maxFileFanout: 5 })).toHaveLength(4);
  });
});

describe("mineKnowledgeLinks — relation precedence", () => {
  it("keeps the strongest relation when two rules propose the same pair", () => {
    const original = commit({
      shortSha: "aaaaaaaa",
      subject: "add strict tuples (#77)",
      date: "2026-01-01T00:00:00Z",
      files: ["src/core.ts"],
    });
    const revert = commit({
      shortSha: "bbbbbbbb",
      subject: 'Revert "add strict tuples (#77)"',
      body: `This reverts commit ${original.sha}. Re-opens #77.`,
      date: "2026-01-02T00:00:00Z",
      files: ["src/core.ts"],
    });
    const links = mineKnowledgeLinks([original, revert]);
    // All three rules fire on this pair; only one edge survives, the strongest.
    expect(links).toHaveLength(1);
    expect(links[0]?.relation).toBe("reverts");
  });
});

describe("adjacency", () => {
  it("is bidirectional, so a hit on either end reaches the other", () => {
    const links = mineKnowledgeLinks([
      commit({ shortSha: "aaaaaaaa", date: "2026-01-01T00:00:00Z", files: ["src/core.ts"] }),
      commit({ shortSha: "bbbbbbbb", date: "2026-01-02T00:00:00Z", files: ["src/core.ts"] }),
    ]);
    const adjacency = buildAdjacency(links);
    expect(adjacency.get("aaaaaaaa")).toHaveLength(1);
    expect(adjacency.get("bbbbbbbb")).toHaveLength(1);
    expect(otherEnd(links[0]!, "aaaaaaaa")).toBe("bbbbbbbb");
    expect(otherEnd(links[0]!, "bbbbbbbb")).toBe("aaaaaaaa");
  });
});
