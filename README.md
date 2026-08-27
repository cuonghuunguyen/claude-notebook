# Codebase Cognitive Memory

Your coding agent already finds *where* code lives — `grep` does that in one
turn. It cannot recover *why* the code is the way it is: what the obvious
implementation broke, what was tried and reverted, which invariant a strange
early-return protects. That reasoning exists in commit messages and in what an
agent works out while reading your repo, and it is thrown away at the end of
every session.

This tool mines it into a SQLite file and hands it back on the next task.
Measured against an agent that had full `git log` / `git blame` / `git grep`
access to the same history: **6.5 → 1.8 turns and −43% cost per question**
(details in [Does it work](#does-it-work)).

> **Status: research / dogfooding repository.** Nothing is published to npm;
> every package is `private`. You run it from a clone. It works on any
> repository in any language — nothing here parses source code — but the
> ergonomics are a script, not a product.

---

## Install

Node ≥ 20 and pnpm 10. No database server, no Docker, no connection string.

```bash
git clone git@github.com:cuonghuunguyen/claude-notebook.git
cd claude-notebook
pnpm install
pnpm build
```

The store is one SQLite file, created on first write. For your own repo it
defaults to `<your-repo>/.claude/memory.db`; `MEMORY_DB` overrides it.

## Turn your codebase into memory

```bash
# from the claude-notebook clone; REPO_DIR is the repo you want to remember
REPO_DIR=/path/to/your/repo node scripts/self-memory.mjs sync
```

```json
{ "repoId": "your-repo", "explanatoryCommits": 177, "experiencesAdded": 177,
  "knowledgeMs": 283, "staleness": { "candidates": 177, "markedSuspect": 164 } }
```

`sync` walks your git history and keeps the commits that **explain themselves**:
a body of at least 200 characters that says *why* — `because`, `instead`,
`revert`, `decided`, `chose`, `rather than`, `trade-off`, `deliberately`. A bare
`fix typo` is skipped, because its knowledge is re-derivable from the diff. Each
kept commit becomes a memory anchored to the files that commit touched.

Re-run it after every merge. It is idempotent — already-recorded commits are
skipped — and it also re-flags memories that newer commits have overtaken.

**What you get depends on your commit messages.** A history of `wip` and
`fix stuff` produces almost nothing. Run `sync` first and read
`explanatoryCommits`: that number is your corpus.

## Ask it

```bash
REPO_DIR=/path/to/your/repo node scripts/self-memory.mjs ask "why was the base64 change reverted?"
```

```
## Why / prior knowledge (4)

### Revert "fix(v4): reject whitespace in z.base64() to close atob bypass"
_commit 23edf484 · 2026-04-28 · hybrid_match (text+trigram+vector), score 0.0325_

> **possibly-stale — verify before trusting** (modified packages/zod/src/v4/core/schemas.ts in 24cdb7fd (+49 more))
> run the `refine-memory` skill to repair it — `/refine-memory 052b791f-…`

That commit landed on main accidentally — it was meant to be pushed to a
new branch but the worktree's upstream tracking pointed at main …
```

Matching is by meaning, against the memory's own text: full-text (FTS5 + bm25),
trigram for identifiers, and vector cosine, fused by weighted RRF. Not by file
path, and not by whichever file you happen to be editing.

**`possibly-stale` is a warning, not a filter.** A memory is flagged when a
*newer* commit touched a file it is anchored to. It is still returned, because a
possibly-outdated reason beats no reason. To settle a flag instead of living
with it, `/refine-memory <id>` reads the anchored files and the commits since,
then either records a correction that supersedes the memory or confirms it.
Nothing is ever deleted; `history <id>` shows what you used to believe.

Expect a high flag rate: capture anchors a mined memory to every file its commit
touched, so on this repo all 41 memories are flagged today, and a `sync` of zod
flagged 164 of 177. A flag means a file changed, never that the memory is wrong.

## Let agents write back what they worked out

Mined commits are half the corpus. The other half is what an agent figures out
while reading your code, which is otherwise lost when the session ends.

A hook cannot synthesize understanding; only the agent that did the reading can.
So the contract is a drop box. Copy two things into your repo:

1. **`.claude/hooks/scout-capture.sh`** from this repo, wired as a `Stop` hook in
   `.claude/settings.json`.
2. An instruction in your `CLAUDE.md` telling agents to write
   `.claude/scout-report.json` when a task made them understand how something
   fits together:

```json
{ "task": "how the retrieval legs are fused",
  "understanding": "prose: three legs run independently and are fused by weighted RRF because …",
  "anchors": ["src/search/fuse.ts"] }
```

At the end of the task the hook persists it and clears the file, so the next
session retrieves it instead of re-deriving it.

**Synthesized understanding only.** The report is rejected if `understanding` is
under 200 characters, under 25 prose words once paths and symbols are stripped,
or is really a file listing wearing prose punctuation. "X lives in file Y" is a
question grep answers in one turn, so storing it buys no turns and adds
staleness risk. A rejected report is kept on disk with the reason, not silently
dropped.

## Daily commands

```bash
REPO_DIR=/my/repo node scripts/self-memory.mjs sync            # after every merge (idempotent)
REPO_DIR=/my/repo node scripts/self-memory.mjs ask "why ...?"  # the reasoning behind the code
REPO_DIR=/my/repo node scripts/self-memory.mjs stats           # corpus size, tiers, flags
REPO_DIR=/my/repo node scripts/self-memory.mjs suspects        # the read-repair worklist
REPO_DIR=/my/repo node scripts/self-memory.mjs verify <id>     # checked it, still accurate
REPO_DIR=/my/repo node scripts/self-memory.mjs supersede f.json# checked it, here is the correction
REPO_DIR=/my/repo node scripts/self-memory.mjs history <id>    # what we used to believe
```

Omit `REPO_DIR` and every command runs against this repository — the dogfooding
setup, and how the project builds itself.

## Use it from code

```ts
import { captureGitHistory } from "@cognitive-memory/capture";
import { runPipeline } from "@cognitive-memory/pipeline";

await captureGitHistory({ repoDir: "/my/repo", pathScope: "", limit: 500, embedder });

const { context, byMeaning, staleness } = await runPipeline(
  "why is the catch handler opt-in?",
  { embedder, stalenessRepoDir: "/my/repo" }
);
```

`runPipeline` is embed-once → by-meaning → read-time staleness → `buildContext`.
`byMeaning` keeps the fusion ranking that `context.experiences` loses when it
re-sorts by recency; `staleness` carries a verdict per memory — key it by
`experience.id`, never by position, since the two lists are ordered differently
on purpose.

The only embedder in the workspace is `createFakeEmbedder`, a feature-hashing
stub. Everything works without it (the two lexical legs carry retrieval); pass a
real one for the vector leg. That is also why vector and trigram are weighted
0.5 against full-text's 1.0.

## What it does not do

- **No npm package, no CLI binary, no MCP server.** You run a script from a
  clone. An agent gets the memory only if it runs `ask` or you wire the output
  into its context.
- **No editor or CI integration.**
- **One repo per database.** Memories are not repo-scoped; `REPO_DIR` keeps them
  apart by defaulting each repo to its own file.
- **Brute-force vector scan.** Fine to roughly 10^5 memories; past that the
  storage decision reopens (`spec.md` §25.7).
- **Nothing parses your source.** By design — identical behaviour for
  TypeScript, Python, SQL, YAML and docs, and no language needs its own
  extractor.

---

## Does it work

Every number below is reproducible from `eval/` against a real clone and a real
database. Read the limitations in each write-up: n = 10 questions on one repo,
one run per cell, questions written by reading the answering commits, and a repo
(zod) with unusually good commit messages. These are trends, not statistics.

**Agent turns and cost.** The baseline is the same agent with full `git log`,
`git show`, `git blame`, `git grep` access, able to mine the very commits the
memory was built from.

| | git-only | with memory | |
|---|---|---|---|
| Turns per question | 6.5 | **1.8** | −72% |
| Cost per question | $0.211 | **$0.121** | −43% |
| Wall-clock | 23.9 s | **9.3 s** | −61% |

2026-08-27, Sonnet in both conditions, blind-graded, every cited commit checked
against `git log`. Accuracy was 20/20 in both, so memory buys speed here, not
correctness. The earlier haiku run (`WHY_MEMORY_SPIKE.md`) measured a larger gap,
7.7 → 1.4 turns, because that baseline agent was weaker.

**Fixing bugs, not just answering questions.** 5 seeded regressions in zod v4,
worktree parked at the fix commit's parent so the answer is not in git history,
graded by applying the real fix commit's tests:

| | bare agent | with memory |
|---|---|---|
| Tasks passing | 4 / 5 | **5 / 5** |
| Turns, all 5 tasks | 86 | **55** (−36%) |
| Cost | $2.03 | **$1.49** (−26%) |

The gain concentrates where a fix spans several branches (a tuple fix went 35 →
13 turns); one-line fixes are neutral. n=5, one run per cell.

**Retrieval quality.** MRR of the commit that actually answers each question:
**0.88, recall 1.00** on a 165-commit corpus.

**What was measured and thrown away.** This began as a structural code graph
(ts-morph → nodes and edges → traversal). Four results ended that, and one more
kept the current design honest:

| Measurement | Result |
|---|---|
| Graph vs grep at finding code (`E2E_BENCHMARK_MULTI_REPO.md`) | Graph loses in every regime, multi-hop included — recall@10 0.46 vs grep 0.67 on lodash |
| Node-gated retrieval vs by-meaning (`BENCHMARKS.md`) | MRR **0.00** vs **0.85**: a `LIMIT 10` newest-on-this-file window drops the explaining commit as a file accumulates commits, so it degrades as the memory fills |
| Decommission gate, 2×2 ablation (`BENCHMARKS.md`) | By-meaning identical to the digit with a full 501-node graph and with none — nothing load-bearing depended on the graph, so five packages and two tables were deleted |
| Knowledge-link edges between memories (`BENCHMARKS.md`) | **NO-GO**: real win (0.60 → 0.90) but underpowered (n=10, p=0.125) and `follows_up` precision 0.00. Not integrated |
| Postgres → SQLite port gate (`BENCHMARKS.md`) | Retrieval moved up (0.85 → 0.883), install cost 621 MB → 0 |

Reproducing the agent comparison:

```bash
git clone https://github.com/colinhacks/zod.git /tmp/zod   # full history, not --depth 1
export ZOD_DIR=/tmp/zod MEMORY_DB=/tmp/why-spike.db
pnpm --filter @cognitive-memory/eval-why-spike build
pnpm --filter @cognitive-memory/eval-why-spike spike:capture
pnpm --filter @cognitive-memory/eval-why-spike spike:probe
pnpm --filter @cognitive-memory/eval-why-spike spike:compare   # needs the `claude` CLI
```

## How it works

```
git history (self-explaining commits)   agent sessions (scout reports)
                    └──────────┬──────────┘
                               ▼
   Experience { task, observation, lessons[], anchors[], confidence, tier }
   anchors are plain text { path, symbol? } — never line numbers, never AST ids
                               ▼
                SQLite (one file, migrations/0001_baseline.sql)
                               ▼
        queryByMeaning() — full-text (bm25, w=1.0) + trigram (w=0.5)
                         + vector (cosine in JS, w=0.5), fused by weighted RRF
                               ▼
              runPipeline() → AgentContext { experiences, … }
```

Anchors are text, so staleness is git-driven and language-agnostic: `sync` and
`stale` flag any memory whose anchored paths a newer commit touched. Memories
that keep getting *usefully* retrieved climb short → mid → long-term tiers,
where tier is a ranking boost and never a filter: a failed task discredits
everything it retrieved, and only memories a session names as used earn credit.

## Running this project

The repo builds itself. Three chained Claude Code skills (`/next-milestone`,
`/propose-milestone`, `/self-improve`) implement a milestone, test it, review the
diff and merge on green CI, stopping for a human whenever a spec deviation is
flagged.

- `spec.md` — the contract. Start at §24 for the current direction.
- `ROADMAP.md` — milestones and live status (source of truth).
- `AGENT_HARNESS.md` — how a session picks this up cold.
- `BENCHMARKS.md` — the append-only measurement log.
- `CLAUDE.md` — the non-negotiable rules for anyone working here.
