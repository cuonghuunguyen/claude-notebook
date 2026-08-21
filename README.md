# Codebase Cognitive Memory

**A memory layer for coding agents that remembers *why* the code is the way it
is — mined from git history and from agents' own sessions, and retrieved by
meaning rather than by file location.**

Agents are already good at finding *where* something lives; `grep` does that in
one turn. What they cannot recover from the working tree is the reasoning that
produced it: what the obvious implementation broke, what was tried and
reverted, which invariant a strange early-return is protecting. That knowledge
exists in commit messages, review threads and in the understanding an agent
builds while scouting a codebase — and today it is thrown away at the end of
every session. This project captures it, stores it in Postgres, and hands it
back on the next task.

> **Status: a research / dogfooding repository.** Nothing here is published to
> npm; every workspace package is `private`. The system is pointed at this
> repository and used by the sessions that build it (see
> [Dogfooding](#dogfooding)). Numbers below are all real measurements from this
> repo's own benchmark harnesses in `eval/`, with their limitations documented
> alongside them — several of them are unflattering.

---

## Why this exists (and what got measured)

The project started as a structural code graph — ts-morph parses your source
into nodes and edges, retrieval traverses them. Two benchmarks killed that
premise and produced the current one.

**1. The structural graph loses to grep at finding code.**
`E2E_BENCHMARK_MULTI_REPO.md`, 12 hand-labelled questions per repo,
recall@10 against a naive keyword-grep baseline over the same files:

| | system recall@10 | grep recall@10 | system MRR | grep MRR |
|---|---|---|---|---|
| zod (heuristic reasoner) | 0.75 | **0.83** | 0.34 | 0.34 |
| lodash (heuristic reasoner) | 0.46 | **0.67** | 0.20 | **0.53** |
| lodash — **multi-hop only** (the regime traversal exists for) | 0.36 | **0.43** | 0.16 | **0.30** |

It loses in every regime, including the multi-hop one that was supposed to be
graph territory.

**2. Memory of *why* beats an agent that already has git.**
`WHY_MEMORY_SPIKE.md` asks the opposite kind of question — *why is the code
like this?* — with the baseline being the same agent holding `git log`,
`git show`, `git blame` and `git grep`, able to mine the very commits the
memory was built from. That is a deliberately high bar:

| | git-only baseline | with memory |
|---|---|---|
| **Mean turns** | 7.7 | **1.4** (−82%) |
| Mean duration | 21.7s | **9.7s** (−55%) |
| Cost, 10 questions | $0.717 | **$0.380** (−47%) |
| Fully answered | 8 / 10 | 10 / 10 |

In 9 of 10 questions the memory condition answered in a **single turn with no
tool calls**. The knowledge was recoverable on demand — it was just expensive,
and precomputing it is what the memory is selling. (The accuracy delta,
0.93 → 1.00, is the weakest claim in that document and is explicitly not leaned
on; the efficiency result is the robust one.)

**3. Retrieval must reach knowledge by its own content, not through the graph.**
The original design hydrated experiences only for nodes that structural
traversal had already hit. Measured on the same question set, re-run through
the shipped packages in M11 (`BENCHMARKS.md`):

| retrieval path | MRR |
|---|---|
| **by-meaning** (match the question against the knowledge text itself) | **0.85** lexical-only · **0.90** with the stub embedder · recall 0.90 |
| node-gated (the original shipped design) | **0.00** |

Node-gating returns a recency-ordered firehose: once a hot file carries dozens
of commits, a `LIMIT 10` newest-on-this-file window drops the commit that
actually explains the decision. It gets *worse* as the memory fills — the
opposite of what a memory layer should do.

**The pivot.** `spec.md` §24 (a direct human decision, 2026-08-19) makes the
knowledge layer the product: capture and by-meaning retrieval move into
`packages/`, anchors become plain text (`{ path, symbol? }`, never line
numbers), staleness becomes git-driven, and the structural graph is slated for
decommission (M15) once nothing load-bearing reads it. A further consequence:
every mechanism in §24 is language-agnostic by construction, where each parser
costs its own extractor forever.

**M15 carried out the decommission**, and it is worth reading how the gate was
designed, because "re-run the eval and check for no regression" would have
proved nothing: a pipeline that still contains the structural stage tells you
nothing about a pipeline without it. So the gate was a **2×2 ablation** — the
zod v4 graph fully ingested (501 nodes, 1171 edges) vs. an empty `nodes` table,
each lexical-only and with the stub embedder. By-meaning scored MRR 0.85 / 0.90
in *both* node conditions, to the digit, same per-question ranks. The node-gated
arm scored **0.00 with the graph present** — it found seeds, traversed, and
returned ten memories for all ten questions, and the answering commit was in
none of them. Not an empty database: the design, at full coverage, pointed at
the wrong thing. Five packages, four eval sets and two tables came out;
`BENCHMARKS.md` has the table and the reproduction commands.

**And one hypothesis that did not survive.** M14 tested whether edges *between
memories* (reverts, shared issue, temporal follow-ups) — relations that exist
nowhere in the source — would pay off where call-graph edges did not. Measured
verdict: **NO-GO**. There is a real retrieval win (bothSlots 0.60 → 0.90) that
survives a random-rewiring control, but it is underpowered (n=10, p=0.125),
confined to 2 of 3 relations covering 27% of memories, and `follows_up` scored
**precision 0.00** on 12 hand-read pairs. Nothing was integrated. The full
write-up, including the threats an independent review pass found, is in
`BENCHMARKS.md`.

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
    since M15 no AST exists. (`relatedNodes` mirrors the paths as text and
    still carries node ids on rows written before M15 — see `spec.md` §24.7.)
                           │
                           ▼
              Postgres 16 + pgvector + pg_trgm
              (migration 0004 gives `experiences` the
               indexes to be searched by its own content)
                           │
                           ▼
                  queryByMeaning()  ── three legs, fused by weighted RRF
                     ├─ full-text   (tsquery, OR-joined + ts_rank)   w=1.0
                     ├─ trigram     (word_similarity, identifiers)   w=0.5
                     └─ vector      (pgvector, injected embedder)    w=0.5
                           │
                           ▼
                   runPipeline() ──▶ AgentContext { experiences, … }
```

The load-bearing path is `capture → experiences → queryByMeaning`, and since
M15 it is the *only* path: there is no structural node to route through, no
seed retrieval and no traversal in front of it. `runPipeline` is embed-once →
by-meaning → read-time staleness → `buildContext`. Nothing in the tree parses
source code, which is why the same mechanisms work unchanged for SQL, YAML,
docs and any language (`spec.md` §24.2 point 7).

Leg weights are not arbitrary knobs: `text` is the reference weight because it
is the leg measured at MRR 0.75 in the spike; `vector` and `trigram` are halved
because the only embedder in the workspace today is `createFakeEmbedder`, a
feature-hashing stub with no measured retrieval quality. A real embedder is
left to the application layer (`spec.md` §9).

---

## Quickstart

Requirements: Node ≥ 20 (CI uses 22), pnpm 10, and a Postgres 16 with
`pgvector` and `pg_trgm`.

```bash
git clone git@github.com:cuonghuunguyen/claude-notebook.git
cd claude-notebook
pnpm install

# Installs/starts a local Postgres with pgvector + pg_trgm.
# This is the verified path in sandboxed dev environments without a Docker daemon.
bash scripts/setup-dev-db.sh

export DATABASE_URL="postgres://postgres:postgres@localhost:5432/cognitive_memory"
pnpm migrate            # runs migrations/0001 … 0008

pnpm build
pnpm typecheck
pnpm lint
pnpm test               # unit tests always run; integration tests need
                        # DATABASE_URL and self-skip without it
```

For integration tests, point `DATABASE_URL` at a disposable database (e.g.
`cognitive_memory_test`) so runs don't pollute your dev data.

CI (`.github/workflows/ci.yml`) runs exactly these commands — typecheck, lint,
build, then the full suite including integration tests — against a
`pgvector/pgvector:pg16` service container on every push and pull request. A
green CI run and a green local run mean the same thing.

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

Only commits that *explain themselves* are kept — a body long enough to carry
reasoning, not a bare "fix typo" whose knowledge is re-derivable from the diff.
Each becomes an `Experience` anchored to the repo-relative paths it touched, as
plain text. The call is **idempotent**: commits already recorded are skipped, so
re-running after a merge is safe.

### Ask it why

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
which is what migration `0004` added the indexes for. `reason` is a
`spec.md` §9-style tag (`text_match` / `lexical_match` /
`semantic_match` / `hybrid_match`, the last when more than one leg agreed).
Scores are comparable **within one call only**.

### Write back what a session worked out

```ts
import { recordScoutReport } from "@cognitive-memory/capture";

await recordScoutReport({
  task: "how the retrieval pipeline composes its legs",  // phrase it as it would be asked again
  understanding: "queryByMeaning runs three independent legs … fused by weighted RRF because …",
  anchors: ["packages/episodic/src/byMeaning.ts", "packages/pipeline/src/pipeline.ts"],
});
```

There is a **guardrail with a measurement behind it**: `packages/capture`
rejects a report that is really a file listing. "X lives in file Y" is a
question grep answers in one turn (measured in
`E2E_BENCHMARK_MULTI_REPO.md`), so persisting it buys no turns and adds
staleness risk. Store synthesized understanding only (`spec.md` §24.2.1).

### Build an agent context in one call

```ts
import { runPipeline } from "@cognitive-memory/pipeline";

const { context, byMeaning, staleness } = await runPipeline(
  "why is the catch handler opt-in?",
  { embedder, stalenessRepoDir: "/path/to/checkout" /*, maxExperiences */ }
);
```

No `graph` and no `reasoner`: until M15 those were required injections for the
traversal stage. `result.byMeaning` exposes the fusion ranking that
`context.experiences` loses when `buildContext` re-sorts by recency, and
`result.staleness` carries the per-memory §24.2.3 verdicts — **key those by
`experience.id`, never by position**, since the two lists are ordered
differently on purpose.

### Dogfooding

`scripts/self-memory.mjs` points the system at *this* repository — it mines this
repo's own explaining commits and the scout reports sessions write back. It used
to ingest structure too; M15 removed that half, which is why `sync` no longer
parses anything and finishes in ~240ms:

```bash
node scripts/self-memory.mjs sync              # structure + our own git history (idempotent)
node scripts/self-memory.mjs ask "why ...?"    # code files + the reasoning behind them
node scripts/self-memory.mjs scout report.json # persist a distilled scout report
node scripts/self-memory.mjs stale             # re-flag what history has overtaken
node scripts/self-memory.mjs suspects          # M13: the read-repair worklist
node scripts/self-memory.mjs verify <id>       # M13: checked it, still accurate
node scripts/self-memory.mjs supersede fix.json# M13: checked it, here's the correction
node scripts/self-memory.mjs history <id>      # what we used to believe
node scripts/self-memory.mjs stats
```

A hit that `ask` returns flagged `possibly-stale` names `/refine-memory <id>`,
the skill that settles it: read the anchored files and the commits since, then
either record a correction that supersedes the memory or confirm it and clear
the mark. Retrieval returns chain heads; nothing is ever deleted.

Since M11 the script is only wiring — which repo, which globs, how output is
printed. The capture and retrieval it used to hand-roll now live in
`packages/capture` and `packages/episodic`.

---

## Package layout

All packages are `@cognitive-memory/*`, TypeScript, ESM, `private: true`.

| Package | What it does | Milestone |
|---|---|---|
| `core` | Shared types: `Experience`, `Anchor`, `Provenance`, `MemoryTier` + the `EmbeddingProvider` contract | M0, M15 |
| `graph-store` | Postgres client, migration runner, typed CRUD over experiences/events/tiers | M0 |
| **`capture`** | **Git-history mining (`captureGitHistory`, idempotent) + session distillation (`recordScoutReport`) + embedding backfill** | **M11** |
| **`episodic`** | **`queryByMeaning` — full-text + trigram + vector legs fused by weighted RRF; plus experience recording/query and supersede chains** | M4, **M11**, M13 |
| `context` | `buildContext` → `AgentContext`, with §17 size caps | M6 |
| `pipeline` | `runPipeline` — by-meaning + read-time staleness + context in one entry point | M9, M11, M15 |
| `staleness` | Text anchors + git-driven memory staleness | M12 |
| `tiers` | Access-driven tier promotion, settled per session | M16 |
| `gc` | §18 retention signal over memories (reported, not acted on) | M7, M16 |

Five packages were removed by M15 — `structural` (ts-morph), `structural-python`
(tree-sitter), `retrieval` (hybrid node search), `semantic` (edge promotion) and
`traversal` (reasoning-guided expansion). `spec.md` §24.7 records what each
retired spec section's implementation was replaced by, and what was deliberately
*kept* despite looking retirable.

Supporting directories:

```
spec.md                   the contract — every design decision traces to a section
ROADMAP.md                milestones, acceptance criteria, current status
AGENT_HARNESS.md          how this repo builds itself, milestone by milestone
BENCHMARKS.md             append-only measurement log (incl. the M14 go/no-go)
WHY_MEMORY_SPIKE.md       the 7.7 → 1.4 turns experiment
E2E_BENCHMARK_*.md        the benchmarks that killed the structural-graph premise
migrations/               0001_init … 0008_decommission_structural
scripts/setup-dev-db.sh   local Postgres + pgvector + pg_trgm setup
scripts/self-memory.mjs   point the system at this repo
eval/                     why-spike (knowledge retrieval), link-spike (M14
                          go/no-go), tier-promotion (M16); e2e-benchmark keeps
                          only its results/ JSON, cited by the reports above
```

---

## Benchmarks

Every number in this README is reproducible from `eval/`. The harnesses take a
real clone and a real Postgres; none of them are mocked.

| Experiment | Question it answers | Verdict | Write-up |
|---|---|---|---|
| E2E multi-repo (zod, lodash) | Does the structural graph beat grep at finding code? | **No**, in every regime | `E2E_BENCHMARK_MULTI_REPO.md` |
| Why-spike | Does memory of *why* beat an agent with full git access? | **Yes** — 7.7 → 1.4 turns, −47% cost | `WHY_MEMORY_SPIKE.md` |
| M11 re-measurement | Does by-meaning beat node-gated retrieval, through the shipped packages? | **Yes** — MRR 0.85 vs 0.00 | `BENCHMARKS.md` |
| M14 link spike | Do memory-to-memory edges pay off where code edges didn't? | **NO-GO** — real but underpowered, `follows_up` precision 0.00 | `BENCHMARKS.md` |
| M15 gate (2×2 ablation) | Does *anything* still measurably depend on structural nodes? | **No** — 0.85/0.90 identical with 501 nodes and with none; node-gated 0.00 in both | `BENCHMARKS.md` |

Reproducing the why-spike, for example:

```bash
git clone https://github.com/colinhacks/zod.git /tmp/zod   # full history, not --depth 1
export ZOD_DIR=/tmp/zod
export DATABASE_URL="postgres://postgres:postgres@localhost:5432/cognitive_memory"

pnpm --filter @cognitive-memory/eval-why-spike build
pnpm --filter @cognitive-memory/eval-why-spike spike:capture
pnpm --filter @cognitive-memory/eval-why-spike spike:probe
pnpm --filter @cognitive-memory/eval-why-spike spike:compare   # needs the `claude` CLI
```

**Read the limitations sections.** They are not boilerplate: n = 10 questions
on one repo for the spike, lexical-only retrieval with no real embedder, zod
having unusually good commit messages, and questions written by reading the
answering commits. These are trends, not statistics, and each document says so
in its own words.

---

## Roadmap status

`ROADMAP.md` is the source of truth; this is a snapshot.

| | Milestone | Status |
|---|---|---|
| M0–M9 | Scaffolding, structural graph, hybrid retrieval, semantic + episodic memory, traversal, context, staleness/GC/eval, Python extraction, pipeline orchestration | ✅ shipped — the structural half later removed by M15 |
| M10 | Structural extraction: variable-bound declarations | ⛔ **superseded, never built** — knowledge-first pivot (`spec.md` §24.3) |
| M11 | **Knowledge Layer as Product** — by-meaning retrieval + capture shipped into `packages/` | ✅ shipped |
| M12 | Text anchors & commit-triggered staleness (git replaces the AST for anchoring) | ✅ shipped |
| M13 | Refine-memory skill — read-repair + `supersedes` chains | ✅ shipped |
| M14 | Knowledge-link edges (measured spike) | ✅ measured → **NO-GO on integrating** |
| M15 | **Decommission the structural graph** — 5 packages, 4 eval sets, 2 tables removed | ✅ shipped — gate passed on a 2×2 ablation |
| M16 | Memory tiers — short/mid/long-term with access-driven promotion | ✅ shipped |

M16 carries a deliberately open problem: **access is not correctness.** A
plausible-but-wrong memory that keeps getting retrieved would climb tiers on
raw hit counts. `spec.md` §24.5 lists three candidate signals
(verification-gated promotion, task-outcome feedback, used-vs-ignored) and
requires M16 to pick one with a measurement rather than an argument.

---

## How this repo is built

This project builds itself milestone by milestone. Three chained Claude Code
skills — `/next-milestone`, `/propose-milestone`, `/self-improve` — implement a
milestone, test it against a real Postgres, self-review the diff, and merge it
when CI is green, spawning a fresh session for the next one so context (and
cost) per milestone stays flat. Anything that flags a spec deviation stops and
waits for a human. Two hooks (`.claude/hooks/quick-typecheck.sh` and
`quality-gate.sh`) catch breakage in the task that caused it and log it to
`QUALITY_LOG.md`.

The rules that keep this honest are in `CLAUDE.md` — most importantly: never
check a milestone box without having run its tests, and never write a
`BENCHMARKS.md` row without a real before/after re-measurement. `BENCHMARKS.md`
is append-only; a row that later turns out to be wrong gets a *new* row saying
so, never an edit.

Full protocol: **`AGENT_HARNESS.md`**.

---

## Where to read next

- **`spec.md`** — the contract. Start at §24 (Knowledge-First Pivot) for the
  current direction, §1–§10 for the model it amends.
- **`ROADMAP.md`** — milestones with acceptance criteria and live status.
- **`AGENT_HARNESS.md`** — how a session picks this up cold and keeps building.
- **`BENCHMARKS.md`** — the append-only measurement log.
- **`CLAUDE.md`** — the non-negotiable rules for anyone (human or agent)
  working in here.
