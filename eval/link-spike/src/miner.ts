/**
 * Candidate memory-to-memory edges, derived from git metadata alone
 * (ROADMAP.md M14, spec.md §24.2 point 5).
 *
 * The hypothesis under test: code-symbol edges lost to grep because grep can
 * reconstruct them from source, but relations *between memories* — commit B
 * reverts commit A, a fix and its regression share an issue, a follow-up
 * touches the same files days later — are recoverable from nothing in the
 * working tree. If that hypothesis is worth anything, a miner reading only
 * `git log` metadata should produce edges a human agrees with, and expanding
 * one hop along them should answer questions a single memory cannot.
 *
 * Deliberately git-metadata-only, and deliberately **not** in `packages/`:
 * this milestone is a go/no-go spike, mirroring `WHY_MEMORY_SPIKE.md`'s method
 * (that spike also lived under `eval/` until M11 promoted the parts that had
 * measurably earned it). Nothing here is imported by the product.
 *
 * No diff is read, no file is parsed, no language is assumed — spec.md §24.2
 * point 7. The miner works identically on a Terraform repo.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ASCII record/unit separators — the same delimiters `packages/capture`'s
// miner uses, chosen because no commit message contains them.
const SEP = "";
const FIELD = "";

/**
 * One commit's metadata. A superset of `packages/capture`'s `CommitRecord`:
 * the miner needs *every* commit, not only the explanatory ones, because a
 * revert of a terse commit is still a revert.
 */
export interface LinkCommit {
  sha: string;
  shortSha: string;
  /** ISO-8601 author date. */
  date: string;
  subject: string;
  body: string;
  /** Repo-relative paths this commit touched, restricted to the mined scope. */
  files: string[];
}

export type LinkRelation = "reverts" | "shares_issue" | "follows_up";

/**
 * A candidate edge. `from` is always the *later* commit and `to` the *earlier*
 * one, so the pair is a stable key regardless of which side retrieval hit
 * first; traversal in the probe is bidirectional.
 */
export interface KnowledgeLink {
  /** Short sha (8) of the later commit. */
  from: string;
  /** Short sha (8) of the earlier commit. */
  to: string;
  relation: LinkRelation;
  /** The git metadata that justified the edge, quoted — what a hand-check reads. */
  evidence: string;
  /**
   * Per-relation prior, used only to order candidates when a budget forces a
   * choice. It is a *prior*, not a measurement: `sample.ts` plus the labels in
   * `labels/` are where the real per-relation precision comes from.
   */
  confidence: number;
}

export interface MineLinksOptions {
  /** Max days between two commits for a `follows_up` edge. Default 14. */
  windowDays?: number;
  /**
   * An issue/PR reference shared by more than this many commits is treated as
   * a topic label rather than a link and dropped. Without it, a repo where one
   * tracking issue is cited by 40 commits emits 780 mutually-connected edges
   * that mean nothing.
   */
  maxIssueFanout?: number;
  /** Skip `follows_up` edges on files touched by more than this many commits in the window. */
  maxFileFanout?: number;
}

const DEFAULTS = { windowDays: 14, maxIssueFanout: 6, maxFileFanout: 60 } as const;

const CONFIDENCE: Record<LinkRelation, number> = {
  reverts: 0.95,
  shares_issue: 0.7,
  follows_up: 0.4,
};

const WHOLE_REPO_SCOPES = new Set(["", ".", "*"]);

/**
 * Path-scope test with a component boundary.
 *
 * A bare `startsWith` would admit a *sibling* directory sharing the prefix —
 * `packages/zod/src/v4` would also match `packages/zod/src/v4-mini`, which is a
 * real directory in this corpus. git's own pathspec does not behave that way,
 * so the two views of "in scope" would disagree.
 */
const inScope = (file: string, pathScope: string): boolean =>
  file === pathScope || file.startsWith(`${pathScope}/`);

/**
 * Reads the commit window as raw metadata.
 *
 * `packages/capture`'s `mineCommits` cannot be reused directly: it applies the
 * `isExplanatory` filter, and the miner needs the unfiltered log so that a
 * revert of a one-line commit is still visible as a revert.
 *
 * Everything *else* about the commit view is copied from it deliberately —
 * `/tests/` paths excluded, and a commit left with no in-scope file dropped.
 * A link is only usable if both ends are memories, so a miner that could see
 * commits capture cannot would report edges the product can never traverse,
 * and the coverage numbers in `sample.ts` would be overstated. (Caught during
 * this milestone: the two views disagreed by 5 commits, one of which was a
 * gold slot in an early draft of `questions.ts`.)
 */
export async function readCommitLog(
  repoDir: string,
  pathScope: string,
  limit = 400
): Promise<LinkCommit[]> {
  const wholeRepo = WHOLE_REPO_SCOPES.has(pathScope);
  const { stdout } = await execFileAsync(
    "git",
    [
      "log",
      `--max-count=${limit}`,
      `--format=${SEP}%H${FIELD}%aI${FIELD}%s${FIELD}%b${FIELD}`,
      "--name-only",
      ...(wholeRepo ? [] : ["--", pathScope]),
    ],
    { cwd: repoDir, maxBuffer: 64 * 1024 * 1024 }
  );

  const commits: LinkCommit[] = [];
  for (const chunk of stdout.split(SEP)) {
    if (!chunk.trim()) continue;
    const [sha, date, subject, body, tail] = chunk.split(FIELD);
    if (!sha || !subject) continue;
    const files = (tail ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(
        (l) => l.length > 0 && (wholeRepo || inScope(l, pathScope)) && !l.includes("/tests/")
      );
    if (files.length === 0) continue;
    commits.push({
      sha,
      shortSha: sha.slice(0, 8),
      date: date ?? "",
      subject,
      body: (body ?? "").trim(),
      files,
    });
  }
  return commits;
}

/**
 * The corpus commit the numbers were measured against.
 *
 * Recorded into every results file: a spike's figures are only reproducible if
 * the exact history window is, and "/tmp/zod" is not a pin. `labels/` names the
 * same sha, so a mismatch between the two is a visible warning that the label
 * file no longer describes the corpus that was mined.
 */
export async function readCorpusRevision(repoDir: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--short=8", "HEAD"], { cwd: repoDir });
  return stdout.trim();
}

/** `git revert` writes this line verbatim; it is the single highest-signal edge in any history. */
const REVERTS_LINE = /this reverts commit ([0-9a-f]{7,40})/gi;
/** `Revert "<subject>"` — what a GitHub "Revert" button produces when the body is squashed away. */
const REVERT_SUBJECT = /^revert\s+"(.+)"\s*$/i;

/**
 * Issue / PR references. Both the bare `#1234` form and the full URL form,
 * because a squash-merge subject carries `(#1234)` while a body more often
 * carries the link.
 */
const ISSUE_REF = /#(\d{1,6})\b/g;
const ISSUE_URL = /github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/(\d{1,6})\b/gi;

function issueRefs(commit: LinkCommit): Set<string> {
  const text = `${commit.subject}\n${commit.body}`;
  const refs = new Set<string>();
  for (const m of text.matchAll(ISSUE_REF)) if (m[1]) refs.add(m[1]);
  for (const m of text.matchAll(ISSUE_URL)) if (m[1]) refs.add(m[1]);
  return refs;
}

const pairKey = (from: string, to: string): string => `${from}->${to}`;

/** Strongest relation wins when two rules propose the same pair. */
const STRENGTH: Record<LinkRelation, number> = { reverts: 3, shares_issue: 2, follows_up: 1 };

/**
 * Derives candidate edges from a commit window.
 *
 * Order matters only for tie-breaking (a pair proposed by two rules keeps the
 * stronger relation); the three rules are otherwise independent, so a repo
 * with no reverts still yields issue and follow-up edges.
 */
export function mineKnowledgeLinks(
  commits: LinkCommit[],
  options: MineLinksOptions = {}
): KnowledgeLink[] {
  const windowDays = options.windowDays ?? DEFAULTS.windowDays;
  const maxIssueFanout = options.maxIssueFanout ?? DEFAULTS.maxIssueFanout;
  const maxFileFanout = options.maxFileFanout ?? DEFAULTS.maxFileFanout;

  // Oldest first: every rule reasons about "the later commit references the
  // earlier one", which is only well-defined on a sorted list.
  const ordered = [...commits].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const bySha = new Map<string, LinkCommit>();
  for (const c of ordered) {
    bySha.set(c.sha, c);
    bySha.set(c.shortSha, c);
  }

  const out = new Map<string, KnowledgeLink>();
  const add = (link: KnowledgeLink): void => {
    if (link.from === link.to) return;
    const key = pairKey(link.from, link.to);
    const existing = out.get(key);
    if (existing && STRENGTH[existing.relation] >= STRENGTH[link.relation]) return;
    out.set(key, link);
  };

  // ---- rule 1: explicit reverts -------------------------------------------
  const subjectIndex = new Map<string, LinkCommit[]>();
  for (const c of ordered) {
    const list = subjectIndex.get(c.subject) ?? [];
    list.push(c);
    subjectIndex.set(c.subject, list);
  }

  for (const later of ordered) {
    let sawShaForm = false;
    for (const m of `${later.subject}\n${later.body}`.matchAll(REVERTS_LINE)) {
      const referenced = m[1];
      if (!referenced) continue;
      sawShaForm = true;
      const target = resolveSha(referenced, bySha, ordered);
      if (!target || target.sha === later.sha) continue;
      // Orient by date, don't assume it. `from` must be the later commit
      // (the invariant documented on `KnowledgeLink`) because `pairKey` is
      // direction-sensitive: a reversed edge would not dedup against the same
      // pair emitted in canonical order by rule 2 or 3, silently
      // double-counting it. A rebase or an imported history can date a
      // referenced commit *after* the commit that references it.
      const [from, to] =
        Date.parse(target.date) > Date.parse(later.date) ? [target, later] : [later, target];
      add({
        from: from.shortSha,
        to: to.shortSha,
        relation: "reverts",
        evidence: `"${m[0]}" in ${later.shortSha} ("${later.subject}")`,
        confidence: CONFIDENCE.reverts,
      });
    }
    if (sawShaForm) continue;
    // Fall back to the subject form only when no sha was given — a body naming
    // the sha is strictly better evidence and is already handled above.
    const bySubject = REVERT_SUBJECT.exec(later.subject);
    const revertedSubject = bySubject?.[1];
    if (!revertedSubject) continue;
    const candidates = (subjectIndex.get(revertedSubject) ?? []).filter(
      (c) => Date.parse(c.date) <= Date.parse(later.date) && c.sha !== later.sha
    );
    const target = candidates.at(-1);
    if (!target) continue;
    add({
      from: later.shortSha,
      to: target.shortSha,
      relation: "reverts",
      evidence: `subject 'Revert "${revertedSubject}"' in ${later.shortSha} matches ${target.shortSha}`,
      confidence: CONFIDENCE.reverts,
    });
  }

  // ---- rule 2: shared issue / PR reference ---------------------------------
  const byRef = new Map<string, LinkCommit[]>();
  for (const c of ordered) {
    for (const ref of issueRefs(c)) {
      const list = byRef.get(ref) ?? [];
      list.push(c);
      byRef.set(ref, list);
    }
  }
  for (const [ref, group] of byRef) {
    if (group.length < 2) continue;
    // A reference cited by many commits is a topic label (a tracking issue, a
    // milestone), not evidence that any two of them are about one change.
    if (group.length > maxIssueFanout) continue;
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const earlier = group[i];
        const later = group[j];
        if (!earlier || !later) continue;
        add({
          from: later.shortSha,
          to: earlier.shortSha,
          relation: "shares_issue",
          evidence: `both cite #${ref}: ${later.shortSha} ("${later.subject}") and ${earlier.shortSha} ("${earlier.subject}")`,
          confidence: CONFIDENCE.shares_issue,
        });
      }
    }
  }

  // ---- rule 3: same file, adjacent in time within the window ---------------
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const byFile = new Map<string, LinkCommit[]>();
  for (const c of ordered) {
    for (const f of c.files) {
      const list = byFile.get(f) ?? [];
      list.push(c);
      byFile.set(f, list);
    }
  }
  for (const [file, group] of byFile) {
    // A file every commit touches (a changelog, a lockfile, a barrel index)
    // links everything to everything and carries no information.
    if (group.length > maxFileFanout) continue;
    // Adjacent pairs only, not the full cross-product: a hot file with n
    // commits in the window would otherwise emit n^2/2 edges asserting that
    // every touch of it is a follow-up to every other.
    for (let i = 1; i < group.length; i += 1) {
      const earlier = group[i - 1];
      const later = group[i];
      if (!earlier || !later) continue;
      const gap = Date.parse(later.date) - Date.parse(earlier.date);
      if (!Number.isFinite(gap) || gap > windowMs) continue;
      add({
        from: later.shortSha,
        to: earlier.shortSha,
        relation: "follows_up",
        evidence: `${later.shortSha} ("${later.subject}") touched ${file} ${formatGap(gap)} after ${earlier.shortSha} ("${earlier.subject}")`,
        confidence: CONFIDENCE.follows_up,
      });
    }
  }

  return [...out.values()];
}

/** Resolves a possibly-abbreviated sha against the mined window. */
function resolveSha(
  referenced: string,
  bySha: Map<string, LinkCommit>,
  ordered: LinkCommit[]
): LinkCommit | undefined {
  const direct = bySha.get(referenced) ?? bySha.get(referenced.slice(0, 8));
  if (direct) return direct;
  // `git revert` writes the full sha, but humans paste 7 characters. Accept any
  // unambiguous prefix rather than silently dropping the highest-signal edge.
  const matches = ordered.filter((c) => c.sha.startsWith(referenced));
  return matches.length === 1 ? matches[0] : undefined;
}

function formatGap(ms: number): string {
  const hours = ms / 3_600_000;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

/** Adjacency for 1-hop expansion: short sha -> the links touching it, either direction. */
export function buildAdjacency(links: KnowledgeLink[]): Map<string, KnowledgeLink[]> {
  const adjacency = new Map<string, KnowledgeLink[]>();
  const push = (sha: string, link: KnowledgeLink): void => {
    const list = adjacency.get(sha) ?? [];
    list.push(link);
    adjacency.set(sha, list);
  };
  for (const link of links) {
    push(link.from, link);
    push(link.to, link);
  }
  return adjacency;
}

/** The other end of a link, given one end. */
export const otherEnd = (link: KnowledgeLink, sha: string): string =>
  link.from === sha ? link.to : link.from;
