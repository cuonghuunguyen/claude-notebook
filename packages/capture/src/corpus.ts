/**
 * Git-history mining: the first of spec.md §24.2.1's two capture source
 * classes.
 *
 * `spec.md` §1 promises an agent can "recover architectural invariants and
 * design decisions" and "recall previous debugging/fixing experiences", and
 * §4 already declares `git_commit` and `pull_request` as provenance source
 * types — but until M11 nothing under `packages/` ever produced one, so the
 * memory only ever contained what the code already said.
 *
 * This module mines the knowledge sitting in a repository's own history — why
 * a fix was made, what it broke, what was reverted and why. It is the exact
 * miner `WHY_MEMORY_SPIKE.md` measured (7.7 -> 1.4 agent turns at -47% cost),
 * moved verbatim out of `eval/why-spike/` so it is a shipped capability rather
 * than a spike artefact; `git.ts` adds the idempotent persistence around it.
 *
 * It shells out to `git` and reads nothing but commit metadata, so it is
 * language-agnostic by construction — spec.md §24.2's point 7, and the reason
 * nothing here may grow a per-language dependency.
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
  /** Repo-relative paths this commit touched, restricted to the mined scope. */
  files: string[];
}

/**
 * Vocabulary that marks a body as *explaining itself* rather than restating the
 * diff. Two dialects, because commits explain themselves in two ways:
 *
 *  - **Repair** (`fix`, `revert`, `regress`, `because`, `instead`, …) — what
 *    broke and what the obvious implementation got wrong. This is the original
 *    set, and the one `WHY_MEMORY_SPIKE.md` measured.
 *  - **Decision** (`decided`, `chose`, `rather than`, `trade-off`, …) — why one
 *    design was taken over another. Added after a dogfood miss: every commit
 *    recording this project's own direction changes (the spec.md §24 pivot, the
 *    §24.5 tier design, the capture-scope widening) was rejected by the repair
 *    dialect alone, despite bodies of 450–825 characters of pure reasoning.
 *    spec.md §24.2.1 names "design decisions" first among what capture is for,
 *    so a rule that could only see bugfixes was reading the spec backwards.
 *
 * The set is only ever widened, never narrowed, so no commit that qualified
 * before stops qualifying. That is NOT the same as "the spike's number still
 * holds": extra memories are extra competitors in ranking, so widening can only
 * make retrieval harder. It was therefore measured rather than assumed —
 * BENCHMARKS.md reports the zod probe under both vocabularies on separate
 * databases (0.85 either way; the widening added 2 commits to that corpus).
 */
const EXPLANATORY_VOCABULARY =
  /\b(fix|revert|regress|workaround|perf|breaking|bug|instead|because|so that|decision|decided|decides|chose|chosen|choosing|rather than|trade-?offs?|supersedes?|superseded|deliberately|intentionally|on purpose)\b/i;

/**
 * A commit is worth remembering when it explains itself. A one-line
 * "fix typo" carries no knowledge a future agent could not re-derive from
 * the diff; a body explaining *why* the obvious implementation was wrong, or
 * why one design was taken over another, is exactly what cannot be recovered
 * by reading the code.
 */
export function isExplanatory(subject: string, body: string): boolean {
  const meaningful = body
    .split("\n")
    .filter((l) => !/^(co-authored-by|signed-off-by|-{3,}|\*\s*$)/i.test(l.trim()))
    .join("\n")
    .trim();
  if (meaningful.length < 200) return false;
  return EXPLANATORY_VOCABULARY.test(`${subject} ${meaningful}`);
}

/**
 * `pathScope` values meaning "the whole repository, not a subtree".
 *
 * This exists because of a real dogfood miss, not for symmetry: mining this
 * project's own history under `packages`/`eval` returned none of the commits
 * that recorded its biggest decisions, because those commits touch `spec.md`
 * and `ROADMAP.md` at the repo root and were therefore filtered out — the most
 * valuable "why" in the repository was the part capture could not see. spec.md
 * §24.2 point 7 is explicit that these mechanisms work identically for docs,
 * SQL, YAML and infra; a mandatory subtree prefix quietly contradicted that.
 */
const WHOLE_REPO_SCOPES = new Set(["", ".", "*"]);

export async function mineCommits(
  repoDir: string,
  pathScope: string,
  limit = 400
): Promise<CommitRecord[]> {
  const wholeRepo = WHOLE_REPO_SCOPES.has(pathScope);
  const { stdout } = await execFileAsync(
    "git",
    [
      "log",
      `--max-count=${limit}`,
      `--format=${SEP}%H${FIELD}%aI${FIELD}%s${FIELD}%b${FIELD}`,
      "--name-only",
      // A pathspec of "" is not the same as no pathspec — git rejects it — so
      // the whole-repo case omits the separator entirely.
      ...(wholeRepo ? [] : ["--", pathScope]),
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
      .filter((l) => l.length > 0 && (wholeRepo || l.startsWith(pathScope)) && !l.includes("/tests/"));
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
