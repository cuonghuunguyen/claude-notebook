/**
 * The git half of commit-triggered staleness (spec.md §24.2.3 / ROADMAP.md
 * M12): which commits touched which paths, with renames followed.
 *
 * "One git lookup, no parser" is the milestone's requirement and this module's
 * whole design constraint. `changedPathsSince` is a *single* `git log`
 * invocation regardless of how many memories or paths are involved — the
 * per-path answer is computed from one walk of its output, not by asking git
 * once per path. Asking per path would be the obvious implementation and would
 * make read-time staleness scale with the number of retrieved memories, which
 * is precisely the cost the AST-diffing approach was rejected for.
 *
 * It shells out to `git` and reads nothing but name-status metadata, so it is
 * language-agnostic by construction (spec.md §24.2 point 7) — no file is ever
 * opened, let alone parsed.
 *
 * Why this is not `packages/capture`'s miner: `mineCommits` filters history down
 * to *explanatory* commits (a body worth remembering) and returns their prose.
 * Staleness needs the opposite — every commit, including the one-line "fix
 * typo" ones, and none of the prose. A "fix typo" commit carries no knowledge
 * but absolutely does make a memory about that file suspect. Sharing a walk
 * between the two would mean one of them getting the wrong commit set.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ChangedPath, ChangeKind } from "@cognitive-memory/core";

const execFileAsync = promisify(execFile);

/** Field separator in the commit header line. ASCII unit separator — cannot appear in a path. */
const FIELD = "";
/** Record separator between commits. */
const SEP = "";

/** Rename similarity threshold handed to `git log -M`. 50% is git's own default for `-M`. */
const RENAME_SIMILARITY = 50;

export interface ChangedPathsOptions {
  /** Absolute path to a git work tree. */
  repoDir: string;
  /**
   * Drop changes whose commit is older than this instant (ISO 8601).
   *
   * Applied in memory, on the AUTHOR date, AFTER the walk — deliberately not as
   * `git log --since`. Two independent reasons, both silent-miss bugs:
   *
   *  1. `--since` is evaluated on the **committer** date, while `date` below is
   *     the **author** date (`%aI`) — the one capture stamps onto a mined memory
   *     and therefore the one staleness must compare. A rebased or cherry-picked
   *     commit authored after a memory but committed before the window is
   *     dropped by git and never flagged.
   *  2. `--since` is a traversal **cutoff**, not a filter: git stops walking at
   *     the first commit older than the bound (which is why `--since-as-filter`
   *     exists). One out-of-order commit date — clock skew, `commit --amend
   *     --date`, imported history, a rebase that reorders — truncates the walk
   *     early, and every memory then reports fresh.
   *
   * Filtering here costs the same walk and cannot be wrong about which clock it
   * used. `limit` is the bound that actually keeps the walk cheap.
   */
  since?: string;
  /** Restrict the walk to these repo-relative paths. Omitted ⇒ the whole repo. */
  paths?: readonly string[];
  /**
   * Max commits walked. Default 1000. This, not `since`, is what bounds cost —
   * so a repository with more history than this has renames and edits older
   * than the cap that no pass can see. Raise it for a full audit of a long
   * history.
   */
  limit?: number;
}

/**
 * Undoes git's C-style path quoting.
 *
 * git quotes a path in `--name-status` output whenever it contains a character
 * it considers unsafe, wrapping it in `"` and escaping the offending bytes —
 * `src/füü.ts` becomes `"src/f\303\274\303\274.ts"`. Left unhandled, that
 * string matches no anchor anyone ever recorded, so a memory bound to such a
 * path would silently never be flagged: precisely the "missed flag" failure
 * §24.2.3 cares about, and invisible because nothing errors.
 *
 * `-c core.quotePath=false` (below) already takes care of the non-ASCII case,
 * which is the common one. This handles what that flag deliberately does NOT
 * unquote: genuine control characters, tab above all — a literal tab in a
 * filename would otherwise break the tab-separated parse itself.
 *
 * Octal escapes are decoded as *bytes* and the result decoded as UTF-8 at the
 * end, because a multi-byte character arrives as several separate escapes
 * (`\303\274` is one `ü`). Decoding each escape as its own character would
 * produce mojibake.
 */
export function unquoteGitPath(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const body = raw.slice(1, -1);
  const SIMPLE: Record<string, number> = {
    a: 0x07, b: 0x08, t: 0x09, n: 0x0a, v: 0x0b, f: 0x0c, r: 0x0d,
    '"': 0x22, "\\": 0x5c,
  };
  const bytes: number[] = [];
  const pushUtf8 = (text: string) => {
    for (const byte of Buffer.from(text, "utf8")) bytes.push(byte);
  };

  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i] as string;
    if (ch !== "\\") {
      pushUtf8(ch);
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) break;
    i += 1;
    const simple = SIMPLE[next];
    if (simple !== undefined) {
      bytes.push(simple);
      continue;
    }
    if (next >= "0" && next <= "7") {
      const octal = body.slice(i, i + 3);
      const value = Number.parseInt(octal, 8);
      if (!Number.isNaN(value)) {
        bytes.push(value & 0xff);
        i += octal.length - 1;
        continue;
      }
    }
    // Unknown escape: keep the character as written rather than dropping it.
    pushUtf8(next);
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Maps git's `--name-status` letter to a `ChangeKind`. */
function kindFor(status: string): ChangeKind {
  const letter = status[0];
  if (letter === "A") return "added";
  if (letter === "D") return "deleted";
  if (letter === "R") return "renamed";
  // C (copy), M (modify), T (typechange), U (unmerged) all mean "the content at
  // this path is not what it was", which is all a file-level trigger needs.
  return "modified";
}

/**
 * Every path touched by every commit in the window, newest commit first.
 *
 * Renames arrive as one `ChangedPath` with `previousPath` set, NOT as a
 * delete+add pair — this is the "follows git renames rather than treating a
 * rename as a delete" requirement, and it is `-M` that produces it. Without
 * `-M`, `git mv` shows up as `D old` + `A new`, and a memory anchored to `old`
 * would be flagged against a file git thinks is gone rather than followed to
 * where the code actually went.
 *
 * `--no-merges` is set because `git log --name-status` reports nothing for a
 * merge commit anyway unless `--diff-merges` is passed, so excluding them costs
 * no coverage and keeps the output honest about what it contains.
 *
 * The residual, stated rather than glossed: a change that exists ONLY in a merge
 * commit — a conflict resolution, an "evil merge" — is invisible here, so a
 * memory anchored to a file touched only that way is not flagged. Surfacing it
 * would mean `--diff-merges=first-parent`, which re-reports every path from
 * every merged branch and inflates the walk substantially. Same class of
 * documented blind spot as `limit`, not a claim of completeness.
 */
export async function changedPathsSince(options: ChangedPathsOptions): Promise<ChangedPath[]> {
  const args = [
    // Overrides whatever the user's config says, so parsing never depends on
    // it: with quoting on, a non-ASCII path arrives escaped and matches no
    // anchor. Must precede the subcommand.
    "-c",
    "core.quotePath=false",
    "log",
    `--max-count=${options.limit ?? 1000}`,
    "--no-merges",
    `--format=${SEP}%H${FIELD}%aI`,
    "--name-status",
    `-M${RENAME_SIMILARITY}%`,
  ];

  // A pathspec is the caller's choice, and callers that want renames followed
  // must NOT pass one. `git log -- old/path.ts` returns nothing once the file
  // has been renamed away, so restricting the walk to a memory's anchored paths
  // is exactly how you lose the rename that moved it. `limit` is the bound
  // instead; the pathspec exists for callers who genuinely want one subtree
  // (e.g. a monorepo package sync).
  const paths = options.paths?.filter((p) => p.trim().length > 0) ?? [];
  if (paths.length > 0) args.push("--", ...paths);

  const { stdout } = await execFileAsync("git", args, {
    cwd: options.repoDir,
    maxBuffer: 64 * 1024 * 1024,
  });

  // Author-date floor, applied to the parsed output rather than handed to git.
  const sinceMs = options.since ? Date.parse(options.since) : Number.NaN;
  const floor = Number.isNaN(sinceMs) ? undefined : sinceMs;

  const changes: ChangedPath[] = [];
  for (const chunk of stdout.split(SEP)) {
    if (!chunk.trim()) continue;
    const newline = chunk.indexOf("\n");
    const header = newline === -1 ? chunk : chunk.slice(0, newline);
    const [sha, date] = header.split(FIELD);
    if (!sha) continue;
    if (floor !== undefined) {
      const commitMs = Date.parse(date ?? "");
      // An undated commit is kept: dropping it would be a silent miss, and
      // `isPossiblyStale` already treats a missing date as "cannot be newer".
      if (!Number.isNaN(commitMs) && commitMs < floor) continue;
    }
    const body = newline === -1 ? "" : chunk.slice(newline + 1);

    for (const line of body.split("\n")) {
      if (!line.trim()) continue;
      // `--name-status` is tab-separated: `M\tpath`, or `R096\told\tnew`.
      const [status, rawFirst, rawSecond] = line.split("\t");
      if (!status || !rawFirst) continue;
      const first = unquoteGitPath(rawFirst);
      const second = rawSecond ? unquoteGitPath(rawSecond) : undefined;
      const kind = kindFor(status);
      if (kind === "renamed" && second) {
        changes.push({ path: second, previousPath: first, kind, sha, date: date ?? undefined });
      } else {
        changes.push({ path: first, kind, sha, date: date ?? undefined });
      }
    }
  }
  return changes;
}
