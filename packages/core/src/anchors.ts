/**
 * Text anchors (spec.md §24.2.2 / ROADMAP.md M12).
 *
 * A memory binds to `{ path, symbol? }` — a repo-relative file path plus an
 * optional symbol *name as text*. Never a line number, and never a structural
 * node id.
 *
 * Why not line numbers: they rot on every edit above the symbol, so a memory
 * anchored to `src/parse.ts:412` is wrong the first time anyone adds an import.
 * Why not node ids: §24.3 records the measurement that killed that idea — the
 * winning retrieval path never routes through a node hit, so requiring a node
 * to exist before knowledge can be anchored buys nothing and costs a parser
 * per language (§24.2 point 7).
 *
 * Everything in this file is pure and language-agnostic: it matches strings
 * against strings. The git side (which commits touched which paths) lives in
 * `packages/staleness`; this module is the part that has to be right, and is
 * therefore the part that is unit-tested without a database or a repository.
 */

/**
 * Where a memory is bound in the codebase. `symbol` is a plain name
 * (`parseAnchor`, `ZodCatch`, `handle_request`) to be re-found lexically at
 * read time — a moved symbol is still the same anchor.
 */
export interface Anchor {
  path: string;
  symbol?: string;
}

/** Separator between path and symbol in an anchor's text form. */
export const ANCHOR_SYMBOL_SEPARATOR = "#";

/**
 * The tag a possibly-stale memory carries into the agent's context
 * (spec.md §24.2.3). Exact wording is fixed by the spec, so it lives here
 * rather than being retyped by every renderer.
 */
export const POSSIBLY_STALE_FLAG = "possibly-stale — verify before trusting";

/**
 * What a reader should DO about a possibly-stale memory (ROADMAP.md M13 (c)).
 *
 * Split from `POSSIBLY_STALE_FLAG` rather than folded into it: the flag's
 * wording is fixed by spec.md §24.2.3 and is rendered into machine-read
 * context (`packages/context`'s `staleness` field), while this is operator
 * guidance for a human/agent-facing listing. Renderers that emit the flag as a
 * value must not silently start emitting an instruction as that value.
 */
export const REFINE_MEMORY_HINT =
  "run the `refine-memory` skill to repair it (write a correction) or confirm it";

/** How a commit touched a path. `renamed` carries `previousPath`. */
export type ChangeKind = "added" | "modified" | "deleted" | "renamed";

/** One path touched by one commit — the unit anchor matching works against. */
export interface ChangedPath {
  /** Repo-relative path as of that commit (the *new* path for a rename). */
  path: string;
  /** Only for `renamed`: where the file lived before. */
  previousPath?: string;
  kind: ChangeKind;
  /** Commit that made the change, short or full sha. */
  sha?: string;
  /** Author date, ISO 8601. */
  date?: string;
}

/** `{ path, symbol }` -> `path#symbol`. Symbol-less anchors are just the path. */
export function formatAnchor(anchor: Anchor): string {
  return anchor.symbol
    ? `${anchor.path}${ANCHOR_SYMBOL_SEPARATOR}${anchor.symbol}`
    : anchor.path;
}

/**
 * What may follow `#` and still count as a symbol: an identifier, optionally
 * dotted (`Class.method`, `module.fn`).
 *
 * The check is necessary because `#` is legal in a filename, so "text after the
 * last `#`" is NOT enough to identify a symbol. `docs/C#-notes.md` and
 * `test/fixtures/issue#123.ts` are paths, not `path#symbol` pairs, and splitting
 * them yields an anchor pointing at a file that does not exist — after which
 * staleness silently never fires for that memory, because nothing matches and
 * nothing errors. Requiring the suffix to look like an identifier rejects both
 * (`-notes.md` starts with `-`, `123.ts` with a digit) while accepting every
 * real symbol.
 */
const SYMBOL_SUFFIX = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

/**
 * `path#symbol` -> `{ path, symbol }`.
 *
 * Splits on the LAST separator (a symbol name never contains one) and only when
 * what follows actually looks like a symbol — see `SYMBOL_SUFFIX`. Anything
 * else is one opaque path, which is the safe reading: a path that keeps its `#`
 * still matches the file git reports, whereas a wrongly-split one matches
 * nothing at all.
 */
export function parseAnchor(text: string): Anchor {
  const trimmed = text.trim();
  const at = trimmed.lastIndexOf(ANCHOR_SYMBOL_SEPARATOR);
  if (at <= 0 || at === trimmed.length - 1) return { path: trimmed };
  const suffix = trimmed.slice(at + 1);
  if (!SYMBOL_SUFFIX.test(suffix)) return { path: trimmed };
  return { path: trimmed.slice(0, at), symbol: suffix };
}

/**
 * True for a `nodeId()` output (spec.md §3.2: 32 hex chars).
 *
 * Needed because `relatedNodes` is a mixed bag by design: migration 0001 made
 * it a non-foreign-key jsonb array, M11's capture wrote plain paths into it,
 * and the structural graph (alive until M15) still writes real node ids there.
 * Reading anchors out of a pre-M12 memory means telling the two apart, and
 * this is the only distinguishing feature available — a 32-char lowercase hex
 * string is not a plausible repo-relative path.
 */
export function isNodeId(value: string): boolean {
  return /^[0-9a-f]{32}$/.test(value);
}

/**
 * Anchors implied by a legacy `relatedNodes` array — the migration path for
 * every memory captured before this milestone.
 *
 * Node ids are dropped rather than turned into anchors: a node id names a
 * symbol, not a path, so there is nothing for git to check it against. It stays
 * in `relatedNodes` where the structural graph can still use it.
 */
export function anchorsFromRelatedNodes(relatedNodes: readonly string[]): Anchor[] {
  return dedupeAnchors(
    relatedNodes.filter((value) => value.trim().length > 0 && !isNodeId(value)).map(parseAnchor)
  );
}

/** Distinct anchors, first occurrence wins, order preserved. */
export function dedupeAnchors(anchors: readonly Anchor[]): Anchor[] {
  const seen = new Map<string, Anchor>();
  for (const anchor of anchors) {
    const key = formatAnchor(anchor);
    if (!seen.has(key)) seen.set(key, anchor);
  }
  return [...seen.values()];
}

/**
 * `previousPath -> path` for every rename in `changes`.
 *
 * This is the "follows git renames rather than treating a rename as a delete"
 * half of M12. Without it, `git mv src/a.ts src/b.ts` would look to every
 * memory anchored at `src/a.ts` like the file was deleted — so either the
 * memory silently stops matching anything (staleness never fires again) or it
 * is treated as orphaned. Both are wrong: the code is still there, it moved.
 */
export function renameMapFrom(changes: readonly ChangedPath[]): Map<string, string> {
  const renames = new Map<string, string>();
  for (const change of changes) {
    if (change.kind === "renamed" && change.previousPath) {
      renames.set(change.previousPath, change.path);
    }
  }
  return renames;
}

/**
 * Every path an anchor has occupied from `path` forward, following renames.
 *
 * Forward-only, deliberately. An anchor records where the file was *at capture
 * time*, so renames that matter are the ones that happened since — they move
 * the anchor forward. Following backwards (git's own `--follow` direction)
 * would answer a different question: "what was this file called before the
 * memory existed", which no staleness check needs. A commit older than the
 * memory cannot make it stale, so the pre-capture history is uninteresting by
 * construction.
 *
 * The chain is walked with a visited set, so a rename cycle within one window
 * (`a -> b` and `b -> a` in different commits) terminates instead of hanging.
 */
export function anchorPathHistory(
  path: string,
  renames: ReadonlyMap<string, string>
): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = path;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = renames.get(current);
  }
  return chain;
}

/**
 * Does this change touch this anchor?
 *
 * File-level, per M12: a commit touching the anchored *path* counts, whether or
 * not it went anywhere near the anchored symbol. Deciding "did this commit
 * actually change `parseAnchor`" needs a parser, which §24.2 point 7 rules out
 * of the load-bearing path — and the cheap answer errs toward flagging, which
 * is the safe direction: §24.2.3 keeps flagged memories in the result, so a
 * false flag costs a verification the agent was free to skip, while a missed
 * flag costs silent trust in stale knowledge.
 *
 * A rename matches on either side of the move, so the commit that renames a
 * file makes memories anchored to its old path suspect.
 */
export function changeTouchesAnchor(
  change: ChangedPath,
  anchor: Anchor,
  renames: ReadonlyMap<string, string> = new Map()
): boolean {
  const paths = new Set(anchorPathHistory(anchor.path, renames));
  if (paths.has(change.path)) return true;
  return change.previousPath !== undefined && paths.has(change.previousPath);
}

/**
 * The changes that touch any of `anchors`, with renames resolved across the
 * whole list.
 *
 * The rename map is built from ALL of `changes` before matching, not per
 * change: `a.ts -> b.ts` in one commit and a later edit to `b.ts` in another
 * are two separate entries, and only a list-wide map lets the second one match
 * a memory still anchored at `a.ts`.
 */
export function matchAnchors(
  anchors: readonly Anchor[],
  changes: readonly ChangedPath[]
): ChangedPath[] {
  if (anchors.length === 0 || changes.length === 0) return [];
  const renames = renameMapFrom(changes);

  // Resolve each anchor's rename chain ONCE into a single shared lookup set,
  // rather than per (change, anchor) pair. The pairwise form (what
  // `changeTouchesAnchor` does for a single check) is O(changes x anchors) Set
  // allocations: measured at ~20 ms for one memory against a 10k-change window,
  // which is seconds per sync at a few hundred candidate memories and is paid
  // per retrieved memory on the read path too. This is one pass over the
  // anchors and one pass over the changes.
  const watched = new Set<string>();
  for (const anchor of anchors) {
    for (const path of anchorPathHistory(anchor.path, renames)) watched.add(path);
  }

  return changes.filter(
    (change) =>
      watched.has(change.path) ||
      (change.previousPath !== undefined && watched.has(change.previousPath))
  );
}

/**
 * Every path name appearing anywhere in `changes`, including the pre-rename
 * side of a rename.
 *
 * This is the prefilter for the sync-time pass: it turns a commit range into
 * the set of anchor paths worth looking up in storage, so the pass fetches
 * candidate memories instead of every memory ever recorded.
 *
 * Including `previousPath` is what makes renames survive the prefilter. A
 * memory anchored at `old/a.ts` is only findable by that string, so if the
 * window's rename entry did not contribute `old/a.ts` the memory would never
 * be a candidate and the later edits to `new/a.ts` could never flag it. The
 * corollary is worth stating: the window has to CONTAIN the rename for it to be
 * followed. A sync whose `since` starts after the rename sees only `new/a.ts`
 * and cannot connect it to a memory still anchored at `old/a.ts` — which is why
 * the sync pass defaults to no `since` bound rather than a recent one.
 */
export function changedPathUniverse(changes: readonly ChangedPath[]): string[] {
  const paths = new Set<string>();
  for (const change of changes) {
    paths.add(change.path);
    if (change.previousPath) paths.add(change.previousPath);
  }
  return [...paths];
}

/**
 * The newest `date` among `changes`, or undefined if none carry one.
 * ISO 8601 sorts lexicographically only when the offsets match, so this
 * compares parsed instants rather than strings.
 */
export function newestChangeDate(changes: readonly ChangedPath[]): string | undefined {
  let newest: string | undefined;
  let newestMs = -Infinity;
  for (const change of changes) {
    if (!change.date) continue;
    const ms = Date.parse(change.date);
    if (Number.isNaN(ms) || ms <= newestMs) continue;
    newestMs = ms;
    newest = change.date;
  }
  return newest;
}

/**
 * spec.md §24.2.3's staleness test: is the last commit touching this memory's
 * anchored paths newer than the memory itself?
 *
 * Strictly newer. A memory recorded *by* a commit (capture writes the commit's
 * own date onto the mined memory — see graph-store's `recordExperience`) shares
 * that commit's timestamp exactly, and must not be born flagged.
 */
export function isPossiblyStale(
  memoryTimestamp: string,
  lastCommitDate: string | undefined
): boolean {
  if (!lastCommitDate) return false;
  const commitMs = Date.parse(lastCommitDate);
  const memoryMs = Date.parse(memoryTimestamp);
  if (Number.isNaN(commitMs) || Number.isNaN(memoryMs)) return false;
  return commitMs > memoryMs;
}

/**
 * The instant a memory's staleness is measured FROM (spec.md §24.6 / M13).
 *
 * `timestamp` is when the memory was written; `verifiedAt` is when read-repair
 * last checked it against the code and found it still true. Either one makes
 * the claim "as of this instant, this memory matched the code", so the newer of
 * the two is the honest reference — otherwise a verification could never stick:
 * the commit that triggered the flag stays newer than `timestamp` forever, and
 * every subsequent read would re-raise the flag the repair just resolved.
 *
 * Takes the max rather than preferring `verifiedAt` outright. A `verifiedAt`
 * older than the memory itself is nonsense a caller could still write (a clock
 * skew, a replayed verification), and it must not be able to make a memory look
 * *more* stale than its own write instant already does.
 */
export function stalenessAsOf(experience: {
  timestamp: string;
  verifiedAt?: string;
}): string {
  const { timestamp, verifiedAt } = experience;
  if (!verifiedAt) return timestamp;
  const verifiedMs = Date.parse(verifiedAt);
  const writtenMs = Date.parse(timestamp);
  if (Number.isNaN(verifiedMs)) return timestamp;
  if (Number.isNaN(writtenMs)) return verifiedAt;
  return verifiedMs > writtenMs ? verifiedAt : timestamp;
}

/** Human-readable "why is this suspect", recorded on the memory and shown in context. */
export function suspectReason(changes: readonly ChangedPath[]): string {
  const first = changes[0];
  if (!first) return POSSIBLY_STALE_FLAG;
  const sha = first.sha ? ` in ${first.sha.slice(0, 8)}` : "";
  const more = changes.length > 1 ? ` (+${changes.length - 1} more)` : "";
  const moved =
    first.kind === "renamed" && first.previousPath
      ? `${first.previousPath} -> ${first.path}`
      : first.path;
  return `${first.kind} ${moved}${sha}${more}`;
}
