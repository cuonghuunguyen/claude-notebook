/**
 * Builds a throwaway git repository with real commits, so capture is tested
 * against `git` itself rather than against a mock of it.
 *
 * The miner shells out to `git log --name-only` and parses its output
 * (`corpus.ts`); a fake would only prove the parser agrees with the fake. The
 * cost is ~10 real `git` invocations per fixture, which is cheaper than the
 * Postgres round-trips in the same suite.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface FixtureCommit {
  subject: string;
  body: string;
  /** Repo-relative paths this commit writes. */
  files: string[];
  /** Author date, so mined memories carry the history's dates. */
  date?: string;
}

export interface FixtureRepo {
  dir: string;
  /** Full shas in commit order. */
  shas: string[];
  /** First 8 chars of each sha — the identity capture records. */
  shortShas: string[];
}

export async function buildFixtureRepo(commits: FixtureCommit[]): Promise<FixtureRepo> {
  const dir = mkdtempSync(join(tmpdir(), "cm-capture-fixture-"));
  // Every identity field git folds into a commit sha is pinned, INCLUDING the
  // committer date: without it, two fixtures built from the same commit list
  // get different shas (committer date defaults to "now"), and the
  // "re-running writes nothing new" test would only pass when both runs
  // happen to land inside the same second.
  const git = (...args: string[]) =>
    execFileAsync("git", args, {
      cwd: dir,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.com",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.com",
      },
    });

  const gitAt = (date: string, ...args: string[]) =>
    execFileAsync("git", args, {
      cwd: dir,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.com",
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.com",
        GIT_COMMITTER_DATE: date,
      },
    });

  await git("init", "--quiet", "--initial-branch=main");

  const shas: string[] = [];
  for (const [index, commit] of commits.entries()) {
    for (const file of commit.files) {
      const absolute = join(dir, file);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, `// ${commit.subject}\n// revision ${index}\n`);
    }
    await git("add", "-A");
    const date = commit.date ?? `2026-01-0${(index % 9) + 1}T00:00:00Z`;
    await gitAt(date, "commit", "--quiet", "--date", date, "-m", commit.subject, "-m", commit.body);
    const { stdout } = await git("rev-parse", "HEAD");
    shas.push(stdout.trim());
  }

  return { dir, shas, shortShas: shas.map((s) => s.slice(0, 8)) };
}
