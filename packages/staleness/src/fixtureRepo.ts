/**
 * Builds a throwaway git repository with real commits — including real renames
 * and deletions — so the staleness walk is tested against `git` itself.
 *
 * Same rationale and same pattern as `@cognitive-memory/capture`'s
 * `testing.ts`, and deliberately NOT that helper: it only ever writes files,
 * and rename following (the half of M12 most likely to be got wrong) needs
 * `git mv`. Widening a capture-owned helper for a package capture does not
 * depend on would couple them for no gain.
 *
 * Not re-exported from `index.ts` — it spawns `git` via node:child_process and
 * belongs to test suites, not to the package's production surface.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** One commit's worth of work against the fixture tree. */
export interface FixtureStep {
  message: string;
  /** Author + committer date, so mined/compared timestamps are deterministic. */
  date: string;
  /**
   * Committer date, when it must differ from the author date — the shape a
   * rebase, cherry-pick or patch import produces. Only needed by tests that
   * care that `git log --since` filters on THIS date while `%aI` reports
   * `date` above.
   */
  committerDate?: string;
  /** Paths to write (or overwrite) with `content`. */
  write?: Array<{ path: string; content: string }>;
  /** `git mv` pairs, applied before writes. */
  rename?: Array<{ from: string; to: string }>;
  /** `git rm` paths. */
  remove?: string[];
}

export interface FixtureRepo {
  dir: string;
  cleanup(): void;
}

/**
 * Pins every identity field git folds into a commit sha, committer date
 * included: without it two fixtures built from the same step list get different
 * shas, and any assertion about dates becomes a race with the wall clock.
 */
function gitEnv(date: string, committerDate = date): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.com",
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.com",
    GIT_COMMITTER_DATE: committerDate,
  };
}

/**
 * A file body long enough for `git log -M50%` to recognise a rename by
 * similarity. A two-line file renamed and then edited can fall under the
 * threshold and show up as delete+add, which would make a rename test pass or
 * fail for reasons unrelated to the code under test.
 */
export function bulkyContent(seed: string, extraLines = 0): string {
  const base = Array.from({ length: 40 }, (_, i) => `export const ${seed}_${i} = ${i};`);
  const extra = Array.from({ length: extraLines }, (_, i) => `export const ${seed}_extra_${i} = 1;`);
  return [...base, ...extra].join("\n") + "\n";
}

export async function buildFixtureRepo(steps: readonly FixtureStep[]): Promise<FixtureRepo> {
  const dir = mkdtempSync(join(tmpdir(), "cm-staleness-fixture-"));
  const git = (step: Pick<FixtureStep, "date" | "committerDate">, ...args: string[]) =>
    execFileAsync("git", args, { cwd: dir, env: gitEnv(step.date, step.committerDate) });

  await git({ date: steps[0]?.date ?? "2026-01-01T00:00:00Z" }, "init", "--quiet", "--initial-branch=main");

  for (const step of steps) {
    for (const { from, to } of step.rename ?? []) {
      mkdirSync(dirname(join(dir, to)), { recursive: true });
      await git(step, "mv", from, to);
    }
    for (const path of step.remove ?? []) {
      await git(step, "rm", "--quiet", path);
    }
    for (const { path, content } of step.write ?? []) {
      const absolute = join(dir, path);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, content);
    }
    await git(step, "add", "-A");
    // `--date` pins the AUTHOR date; GIT_COMMITTER_DATE in the env pins the
    // committer date. Passing both is what lets a step set them independently.
    await git(step, "commit", "--quiet", "--date", step.date, "-m", step.message);
  }

  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
