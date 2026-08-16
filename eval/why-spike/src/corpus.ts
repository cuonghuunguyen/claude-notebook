/**
 * The capture layer this system does not have.
 *
 * `spec.md` §1 promises an agent can "recover architectural invariants and
 * design decisions" and "recall previous debugging/fixing experiences", and
 * §4 already declares `git_commit` and `pull_request` as provenance source
 * types. Nothing in the shipped packages ever produces one: the only writers
 * of `recordExperience` outside tests are benchmark harnesses. So the memory
 * only ever contains what the code already says.
 *
 * This module mines the knowledge that is sitting in the repository's own
 * history — why a fix was made, what it broke, what was reverted and why —
 * and binds each record to the code it touched.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SEP = "";
const FIELD = "";

export interface CommitRecord {
  sha: string;
  shortSha: string;
  date: string;
  subject: string;
  body: string;
  /** Repo-relative paths this commit touched, restricted to the indexed scope. */
  files: string[];
}

/**
 * A commit is worth remembering when it explains itself. A one-line
 * "fix typo" carries no knowledge a future agent could not re-derive from
 * the diff; a body explaining *why* the obvious implementation was wrong is
 * exactly what cannot be recovered by reading the code.
 */
function isExplanatory(subject: string, body: string): boolean {
  const meaningful = body
    .split("\n")
    .filter((l) => !/^(co-authored-by|signed-off-by|-{3,}|\*\s*$)/i.test(l.trim()))
    .join("\n")
    .trim();
  if (meaningful.length < 200) return false;
  return /\b(fix|revert|regress|workaround|perf|breaking|bug|instead|because|so that)\b/i.test(
    `${subject} ${meaningful}`
  );
}

export async function mineCommits(
  repoDir: string,
  pathScope: string,
  limit = 400
): Promise<CommitRecord[]> {
  const { stdout } = await execFileAsync(
    "git",
    [
      "log",
      `--max-count=${limit}`,
      `--format=${SEP}%H${FIELD}%aI${FIELD}%s${FIELD}%b${FIELD}`,
      "--name-only",
      "--",
      pathScope,
    ],
    { cwd: repoDir, maxBuffer: 64 * 1024 * 1024 }
  );

  const records: CommitRecord[] = [];
  for (const chunk of stdout.split(SEP)) {
    if (!chunk.trim()) continue;
    const [sha, date, subject, body, tail] = chunk.split(FIELD);
    if (!sha || !subject) continue;
    const files = (tail ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith(pathScope) && !l.includes("/tests/"));
    if (files.length === 0) continue;
    if (!isExplanatory(subject, body ?? "")) continue;
    records.push({
      sha,
      shortSha: sha.slice(0, 8),
      date: date ?? "",
      subject,
      body: (body ?? "").trim(),
      files,
    });
  }
  return records;
}

/**
 * The lesson text an agent would actually want back. Kept close to the
 * author's own words — a commit body is already a human explaining a
 * decision, and paraphrasing it through another model would only lose
 * detail and add a fabrication risk.
 */
export function lessonFrom(commit: CommitRecord): string {
  const body = commit.body
    .split("\n")
    .filter((l) => !/^(co-authored-by|signed-off-by|-{3,})/i.test(l.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return `${commit.subject}\n\n${body}`;
}
