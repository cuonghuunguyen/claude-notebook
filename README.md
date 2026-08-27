# Codebase Cognitive Memory

A memory layer for coding agents. It stores *why* the code is the way it is —
mined from git history and from agents' own sessions — and retrieves it by
meaning, not by file location.

Agents already find *where* code lives; `grep` does that in one turn. The
working tree does not contain the reasoning: what the obvious implementation
broke, what was tried and reverted, which invariant an early-return protects.
That knowledge sits in commit messages, review threads, and in the understanding
an agent builds while scouting, and it is discarded at the end of every session.
This project captures it into a SQLite file and returns it on the next task.

**Status: research / dogfooding repository.** Nothing is published to npm; every
workspace package is `private`. The system is pointed at this repository and
used by the sessions that build it (see [Dogfooding](#dogfooding)). All numbers
below are measurements from this repo's harnesses in `eval/`, with limitations
documented next to them.

---

## Measurements that set the direction

The project started as a structural code graph: ts-morph parses source into
nodes and edges, retrieval traverses them. Three measurements replaced that
premise.

**1. The structural graph loses to grep at finding code.**
`E2E_BENCHMARK_MULTI_REPO.md`, 12 hand-labelled questions per repo, recall@10
against a keyword-grep baseline over the same files:

| | system recall@10 | grep recall@10 | system MRR | grep MRR |
|---|---|---|---|---|
| zod (heuristic reasoner) | 0.75 | **0.83** | 0.34 | 0.34 |
| lodash (heuristic reasoner) | 0.46 | **0.67** | 0.20 | **0.53** |
| lodash — multi-hop only (the regime traversal exists for) | 0.36 | **0.43** | 0.16 | **0.30** |

It loses in every regime, including multi-hop.

**2. Memory of *why* beats an agent that already has git.**
`WHY_MEMORY_SPIKE.md` asks *why is the code like this?* The baseline is the same
agent with `git log`, `git show`, `git blame`, `git grep` — able to mine the
commits the memory was built from.

| | git-only baseline | with memory |
|---|---|---|
| Mean turns | 7.7 | **1.4** (−82%) |
| Mean duration | 21.7s | **9.7s** (−55%) |
| Cost, 10 questions | $0.717 | **$0.380** (−47%) |
| Fully answered | 8 / 10 | 10 / 10 |

In 9 of 10 questions the memory condition answered in a single turn with no tool
calls. The knowledge was recoverable on demand, but expensive; precomputing it is
the value. The accuracy delta (0.93 → 1.00) is the weakest claim in that document
and is not relied on; the efficiency result is the robust one.

Re-measured 2026-08-27 on the SQLite backend with a stronger agent (Sonnet, both
conditions, blind-graded, every cited commit checked against `git log`;
`BENCHMARKS.md`): git-only **6.5** turns / $0.211 / 23.9 s per question →
memory **1.8** turns / $0.121 / 9.3 s (−72% turns, −43% cost, −61% wall).
Accuracy is now 20/20 in both conditions, so the accuracy claim does not
reproduce at all; the baseline is also faster than haiku was, shrinking the
relative gain from 5.5× to 3.6×. n=10, one run per cell.

**3. Retrieval must reach knowledge by its own content, not through the graph.**
The original design hydrated experiences only for nodes that traversal had hit.
Same question set, re-run through the shipped packages (`BENCHMARKS.md`):

| retrieval path | MRR |
|---|---|
| by-meaning (question matched against the knowledge text itself) | **0.85** lexical-only · **0.90** with the stub embedder · recall 0.90 |
| node-gated (the original shipped design) | **0.00** |

Those are the 2026-08-20 numbers on a 142-commit zod corpus. Current by-meaning
numbers on the SQLite backend: MRR **0.883** / **0.933**, recall **1.00**, and
**0.88** / recall **1.00** on the larger 165-commit corpus re-captured
2026-08-27.

Node-gating returns recency-ordered results: once a file carries dozens of
commits, a `LIMIT 10` newest-on-this-file window drops the commit that explains
the decision. Accuracy degrades as the memory fills.

**The pivot.** `spec.md` §24 (human decision, 2026-08-19) makes the knowledge
layer the product: capture and by-meaning retrieval move into `packages/`,
anchors become plain text (`{ path, symbol? }`, never line numbers), staleness
becomes git-driven, and the structural graph is scheduled for decommission once
nothing load-bearing reads it. Consequence: every mechanism in §24 is
language-agnostic by construction, whereas each parser costs its own extractor
permanently.

**The decommission was carried out.** A plain re-run would prove nothing: a
pipeline that still contains the structural stage says nothing about a pipeline
without it. The gate was a 2×2 ablation — the zod v4 graph fully ingested (501
nodes, 1171 edges) vs. an empty `nodes` table, each lexical-only and with the
stub embedder. By-meaning scored MRR 0.85 / 0.90 in both node conditions, to the
digit, same per-question ranks. The node-gated arm scored 0.00 with the graph
present: it found seeds, traversed, returned ten memories for all ten questions,
and the answering commit was in none of them — the design failing at full
coverage, not an empty database. Five packages, four eval sets and two tables
were removed; `BENCHMARKS.md` has the table and the reproduction commands.

**One hypothesis did not survive.** The knowledge-link spike tested whether edges *between memories*
(reverts, shared issue, temporal follow-ups) — relations absent from the source —
pay off where call-graph edges did not. Verdict: **NO-GO**. There is a retrieval
win (bothSlots 0.60 → 0.90) that survives a random-rewiring control, but it is
underpowered (n=10, p=0.125), confined to 2 of 3 relations covering 27% of
memories, and `follows_up` scored precision 0.00 on 12 hand-read pairs. Nothing
was integrated. Full write-up, including threats found by an independent review
pass, in `BENCHMARKS.md`.

---

## Architecture

```
       ┌─────────────────── capture ────────────────────┐
       │                                                │
  git history                                    agent sessions
  (self-explaining commits,                (distilled scout reports:
   design decisions, reverts)               subsystem maps, gotchas)
       │                                                │
       └───────────────────┬────────────────────────────┘
                           ▼
    Experience { task, observation, lessons[], anchors[], confidence, tier }
    `anchors` holds plain-text `{ path, symbol? }` — no AST node required, and
    since the decommission no AST exists. (`relatedNodes` mirrors the paths as
    text and still carries node ids on rows written before it — `spec.md` §24.7.)
                           │
                           ▼
                   SQLite (one file: `.claude/memory.db`)
              (`migrations/0001_baseline.sql`; FTS5 for the
               full-text leg, no extensions of any kind)
                           │
                           ▼
                  queryByMeaning()  ── three legs, fused by weighted RRF
                     ├─ full-text   (FTS5 + bm25, OR-joined terms)   w=1.0
                     ├─ trigram     (word_similarity, identifiers)   w=0.5
                     └─ vector      (Float32 blobs, cosine in JS)    w=0.5
                           │
                           ▼
                   runPipeline() ──▶ AgentContext { experiences, … }
```

The load-bearing path is `capture → experiences → queryByMeaning`, and since the
decommission it is the only path: no structural node to route through, no seed retrieval, no
traversal in front of it. `runPipeline` is embed-once → by-meaning → read-time
staleness → `buildContext`. Nothing in the tree parses source code, so the same
mechanisms work unchanged for SQL, YAML, docs and any language (`spec.md` §24.2
point 7).

Leg weights: `text` is the reference weight because it is the leg measured at
MRR 0.75 in the spike; `vector` and `trigram` are halved because the only
embedder in the workspace is `createFakeEmbedder`, a feature-hashing stub with no
measured retrieval quality. A real embedder is left to the application layer
(`spec.md` §9).

---

## Quickstart

Requirements: Node ≥ 20 (CI uses 22) and pnpm 10. No database to install: the
store is one SQLite file, created on first write (`.claude/memory.db`,
gitignored; `MEMORY_DB` overrides the path).

```bash
git clone git@github.com:cuonghuunguyen/claude-notebook.git
cd claude-notebook
pnpm install

pnpm build && pnpm typecheck && pnpm lint && pnpm test
```

That is the whole setup. Every test runs; nothing self-skips for a missing
connection string, because there is no connection string (`spec.md` §25). Each
integration suite creates its own throwaway SQLite file, so runs cannot pollute
dev data or collide with each other.

`pnpm migrate` applies `migrations/` to the default database if you want to
create it up front; it is not required.

Step one used to be provisioning Postgres 16 with `pgvector` and `pg_trgm`
behind a Docker daemon — 621 MB of image for about 1 MB of text. `spec.md` §25.1
measured that cost and §25 removed it.

CI (`.github/workflows/ci.yml`) runs exactly these commands, with no service
container. A green CI run and a green local run mean the same thing.

---

## Usage

### Mine a repository's history into memory

```ts
import { captureGitHistory } from "@cognitive-memory/capture";

const result = await captureGitHistory({
  repoDir: "/tmp/zod",             // a FULL clone — a shallow one has no history to mine
  pathScope: "packages/zod/src/v4",
  limit: 400,                      // commits git log walks; default 400
});

console.log(result);
// { mined, recorded, alreadyRecorded, unanchored, embeddingsBackfilled, experiences }
```

Only commits that explain themselves are kept: a body long enough to carry
reasoning, not a bare "fix typo" whose knowledge is re-derivable from the diff.
Each becomes an `Experience` anchored as plain text to the repo-relative paths it
touched. The call is idempotent — commits already recorded are skipped, so
re-running after a merge is safe.

### Ask why

```ts
import { queryByMeaning } from "@cognitive-memory/episodic";

const hits = await queryByMeaning("why does the JIT path leak on repeated parse?", {
  limit: 5,
  // embedder,        // omit ⇒ lexical-only (full-text + trigram)
  // includeCold: false,
});

for (const { experience, score, legs, reason, anchored } of hits) {
  console.log(score.toFixed(3), reason, legs, experience.observation.slice(0, 80));
}
```

The lexical legs search `task || ' ' || observation` — the memory's own text —
which the FTS5 and trigram indexes in `migrations/0001_baseline.sql` are built
for. `reason` is a `spec.md`
§9-style tag (`text_match` / `lexical_match` / `semantic_match` /
`hybrid_match`, the last when more than one leg agreed). Scores are comparable
within one call only.

### Write back what a session worked out

```ts
import { recordScoutReport } from "@cognitive-memory/capture";

await recordScoutReport({
  task: "how the retrieval pipeline composes its legs",  // phrase it as it would be asked again
  understanding: "queryByMeaning runs three independent legs … fused by weighted RRF because …",
  anchors: ["packages/episodic/src/byMeaning.ts", "packages/pipeline/src/pipeline.ts"],
});
```

`packages/capture` rejects a report that is really a file listing. "X lives in
file Y" is a question grep answers in one turn (measured in
`E2E_BENCHMARK_MULTI_REPO.md`), so persisting it buys no turns and adds staleness
risk. Store synthesized understanding only (`spec.md` §24.2.1).

### Build an agent context in one call

```ts
import { runPipeline } from "@cognitive-memory/pipeline";

const { context, byMeaning, staleness } = await runPipeline(
  "why is the catch handler opt-in?",
  { embedder, stalenessRepoDir: "/path/to/checkout" /*, maxExperiences */ }
);
```

No `graph` and no `reasoner`: those were required injections for the traversal
stage, which no longer exists. `result.byMeaning` exposes the fusion ranking that
`context.experiences` loses when `buildContext` re-sorts by recency.
`result.staleness` carries the per-memory §24.2.3 verdicts. Key those by
`experience.id`, never by position — the two lists are ordered differently on
purpose.

### Dogfooding

`scripts/self-memory.mjs` points the system at this repository: it mines this
repo's own explaining commits and the scout reports sessions write back. It used
to ingest structure too; the decommission removed that half, which is why `sync`
no longer parses anything and finishes in under 200 ms on this repo.

```bash
node scripts/self-memory.mjs sync              # our own git history + staleness pass (idempotent)
node scripts/self-memory.mjs ask "why ...?"    # the reasoning behind the code
node scripts/self-memory.mjs scout report.json # persist a distilled scout report
node scripts/self-memory.mjs stale             # re-flag what history has overtaken
node scripts/self-memory.mjs suspects          # the read-repair worklist   
node scripts/self-memory.mjs verify <id>       # checked it, still accurate  
node scripts/self-memory.mjs supersede fix.json# checked it, here is the fix 
node scripts/self-memory.mjs history <id>      # what we used to believe
node scripts/self-memory.mjs stats
```

A hit that `ask` returns flagged `possibly-stale` names `/refine-memory <id>`,
the skill that settles it: read the anchored files and the commits since, then
either record a correction that supersedes the memory, or confirm it and clear
the mark. Retrieval returns chain heads; nothing is deleted.

The script is only wiring — which repo, which globs, how output is
printed. The capture and retrieval it used to hand-roll live in
`packages/capture` and `packages/episodic`.

---

## Package layout

All packages are `@cognitive-memory/*`, TypeScript, ESM, `private: true`.

| Package | What it does |
|---|---|
| `core` | Shared types: `Experience`, `Anchor`, `Provenance`, `MemoryTier` + the `EmbeddingProvider` contract |
| `graph-store` | SQLite driver, migration runner, typed CRUD over experiences/events/tiers, the three search legs |
| `capture` | Git-history mining (`captureGitHistory`, idempotent) + session distillation (`recordScoutReport`) + embedding backfill |
| `episodic` | `queryByMeaning` — full-text + trigram + vector legs fused by weighted RRF; plus experience recording/query and supersede chains |
| `context` | `buildContext` → `AgentContext`, with §17 size caps |
| `pipeline` | `runPipeline` — by-meaning + read-time staleness + context in one entry point |
| `staleness` | Text anchors + git-driven memory staleness |
| `tiers` | Access-driven tier promotion, settled per session |
| `gc` | §18 retention signal over memories (reported, not acted on) |

The decommission removed five packages: `structural` (ts-morph), `structural-python`
(tree-sitter), `retrieval` (hybrid node search), `semantic` (edge promotion),
`traversal` (reasoning-guided expansion). `spec.md` §24.7 records what each
retired spec section's implementation was replaced by, and what was kept despite
looking retirable.

Supporting directories:

```
spec.md                   the contract — every design decision traces to a section
ROADMAP.md                milestones, acceptance criteria, current status
AGENT_HARNESS.md          how this repo builds itself, milestone by milestone
BENCHMARKS.md             append-only measurement log (incl. the link-edge go/no-go)
WHY_MEMORY_SPIKE.md       the 7.7 → 1.4 turns experiment
E2E_BENCHMARK_*.md        the benchmarks that replaced the structural-graph premise
migrations/               0001_baseline.sql (the only one; earlier migrations
                          were collapsed into it by the SQLite port)
scripts/self-memory.mjs   point the system at this repo
eval/                     why-spike (knowledge retrieval), link-spike (link-edge
                          go/no-go), tier-promotion; e2e-benchmark keeps only
                          its README and results/ JSON, cited by the reports above
```

---

## Benchmarks

Every number in this README is reproducible from `eval/`. The harnesses use a
real clone and a real SQLite database; none are mocked.

| Experiment | Question it answers | Verdict | Write-up |
|---|---|---|---|
| E2E multi-repo (zod, lodash) | Does the structural graph beat grep at finding code? | **No**, in every regime | `E2E_BENCHMARK_MULTI_REPO.md` |
| Why-spike | Does memory of *why* beat an agent with full git access? | **Yes** — 7.7 → 1.4 turns, −47% cost | `WHY_MEMORY_SPIKE.md` |
| By-meaning re-measurement | Does by-meaning beat node-gated retrieval, through the shipped packages? | **Yes** — MRR 0.85 vs 0.00 | `BENCHMARKS.md` |
| Knowledge-link spike | Do memory-to-memory edges pay off where code edges did not? | **NO-GO** — real but underpowered, `follows_up` precision 0.00 | `BENCHMARKS.md` |
| Decommission gate (2×2 ablation) | Does anything still measurably depend on structural nodes? | **No** — 0.85/0.90 identical with 501 nodes and with none; node-gated 0.00 in both | `BENCHMARKS.md` |
| SQLite port gate | Does dropping Postgres for SQLite cost retrieval quality? | **No, and it moved up** — 0.85/0.90 → **0.883/0.933**, recall 0.90 → 1.00, from `ts_rank` → `bm25` | `BENCHMARKS.md` |
| Why-spike re-measurement (Sonnet, 2026-08-27) | Do the turn/cost savings hold with a stronger agent on SQLite? | **Yes, smaller** — 6.5 → 1.8 turns, −43% cost; no accuracy gap left (20/20 both) | `BENCHMARKS.md` |

Reproducing the why-spike:

```bash
git clone https://github.com/colinhacks/zod.git /tmp/zod   # full history, not --depth 1
export ZOD_DIR=/tmp/zod
export MEMORY_DB=/tmp/why-spike.db   # required: this mines a foreign repo, and
                                     # the default DB is this repo's own memory

pnpm --filter @cognitive-memory/eval-why-spike build
pnpm --filter @cognitive-memory/eval-why-spike spike:capture
pnpm --filter @cognitive-memory/eval-why-spike spike:probe
pnpm --filter @cognitive-memory/eval-why-spike spike:compare   # needs the `claude` CLI
```

Read the limitations sections. They are not boilerplate: n = 10 questions on one
repo for the spike, lexical-only retrieval with no real embedder, zod having
unusually good commit messages, and questions written by reading the answering
commits. These are trends, not statistics, and each document states so.

---

## Roadmap status

`ROADMAP.md` is the source of truth; this is a snapshot.

| Milestone | Status |
|---|---|
| Scaffolding, structural graph, hybrid retrieval, semantic + episodic memory, traversal, context, staleness/GC/eval, Python extraction, pipeline orchestration | ✅ shipped — the structural half later removed |
| Structural extraction: variable-bound declarations | ⛔ superseded, never built — knowledge-first pivot (`spec.md` §24.3) |
| Knowledge Layer as Product — by-meaning retrieval + capture shipped into `packages/` | ✅ shipped |
| Text Anchors & Commit-Triggered Staleness — git replaces the AST for anchoring | ✅ shipped |
| Refine-Memory Skill — read-repair + `supersedes` chains | ✅ shipped |
| Knowledge-Link Edges — measured spike | ✅ measured → **NO-GO on integrating** |
| Decommission the Structural Graph — 5 packages, 4 eval sets, 2 tables removed | ✅ shipped — gate passed on a 2×2 ablation |
| Memory Tiers — short/mid/long-term with access-driven promotion | ✅ shipped |
| Storage Backend: Port to SQLite — Postgres, pgvector, pg_trgm and `DATABASE_URL` removed | ✅ shipped |
| Memories as Markdown, Index as Projection — corpus becomes git-versioned `.md`, SQLite demoted to a derived index (`spec.md` §25.6) | ⬜ next, not started |

Memory tiers carried one open problem: access is not correctness. A
plausible-but-wrong memory that keeps getting retrieved would climb tiers on raw
hit counts. `spec.md` §24.5 records the decision that settled it: promotion
requires *useful* access, composed from two signals — a failed task settles
every memory it retrieved `rejected` (negative, broad), and only memories the
session names as used settle `confirmed` (positive, narrow). Everything else is
neutral. Thresholds: short → mid at 1 confirmed distinct session, mid → long at
2 more earned after reaching mid, inside a 90-day window. Crediting everything a
*passing* task retrieved was measured and scored identically to raw access
counting, which is why the composition is asymmetric.

---

## How this repo is built

This project builds itself milestone by milestone. Three chained Claude Code
skills — `/next-milestone`, `/propose-milestone`, `/self-improve` — implement a
milestone, test it against a real database, self-review the diff, and merge it
when CI is green, spawning a fresh session for the next one so context and cost
per milestone stay flat. Anything that flags a spec deviation stops and waits for
a human. Two hooks (`.claude/hooks/quick-typecheck.sh` and `quality-gate.sh`)
catch breakage in the task that caused it and log it to `QUALITY_LOG.md`.

The rules are in `CLAUDE.md`. The two most important: never check a milestone box
without having run its tests, and never write a `BENCHMARKS.md` row without a
real before/after re-measurement. `BENCHMARKS.md` is append-only; a row that
later turns out to be wrong gets a new row saying so, never an edit.

Full protocol: `AGENT_HARNESS.md`.

---

## Where to read next

- `spec.md` — the contract. Start at §24 (Knowledge-First Pivot) for the current
  direction, §1–§10 for the model it amends.
- `ROADMAP.md` — milestones with acceptance criteria and live status.
- `AGENT_HARNESS.md` — how a session picks this up cold and keeps building.
- `BENCHMARKS.md` — the append-only measurement log.
- `CLAUDE.md` — the non-negotiable rules for anyone, human or agent, working here.
