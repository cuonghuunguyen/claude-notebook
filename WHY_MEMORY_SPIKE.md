# Spike: memory of why, not memory of where

**Run date:** 2026-08-16 · **Branch:** `claude/github-repo-benchmark-61eabd` · **Harness:** `eval/why-spike/` · **Raw data:** `eval/why-spike/results/*.json`

## Scope

Prior conclusion (`E2E_BENCHMARK_MULTI_REPO.md`): the system loses to grep at
finding code, over 24 questions whose answers sat in a file — the regime search
wins by construction. This spike measures the opposite question type: why the
code is as it is (why a branch returns early, what the obvious implementation
broke, what was tried and reverted), not recoverable from the source. It also
fixes what made the earlier cross-session test vacuous: the memory now holds
knowledge mined from the repository's own history.

## Fact: the memory was empty before

- Promised: `spec.md` §1 ("recover architectural invariants and **design
  decisions**", "recall previous **debugging/fixing experiences**"), §4
  (`git_commit`, `pull_request` as provenance source types), §7–§8 (promotion
  lifecycle).
- Actual: no writer in `packages/`. Non-test callers of `recordExperience` /
  `recordObservation` are benchmark harnesses and one test fixture only;
  `git_commit` and `pull_request` are type literals with no producer; the only
  ingestion path is ts-morph over source files.
- Consequence: the memory could hold only what the code says, which is grep's
  strength. **The earlier benchmark measured a knowledge system with an empty
  knowledge layer.**
- Schema tell: `experiences` has indexes on `related_nodes` (gin) and
  `timestamp`, none on a text column — it cannot search knowledge by content.

## Method: capture layer (`src/corpus.ts`, `src/capture.ts`)

Mines zod git history for self-explaining commits: body over 200 characters
containing reasoning, excluding bare messages such as "fix typo" whose
knowledge is re-derivable from the diff. Each becomes an `Experience` via the
shipped `recordExperience`, bound to the file nodes its commit touched. Nothing
in `packages/` was modified.

| | |
|---|---|
| Commits scanned (touching `packages/zod/src/v4`) | 414 |
| Explanatory commits kept | 103 |
| Recorded as experiences bound to code | **94** |
| Distinct files covered | 91 |

## Result 1 — retrieval

Each question has a known answering commit; scored without an agent.

| | recall | MRR |
|---|---|---|
| **node-gated** — the shipped design (traverse code, hydrate experiences on exactly those node ids) | 0.70 | **0.13** |
| **by-meaning** — match the question against the knowledge text itself | **0.90** | **0.75** |

- Node-gated returned 10 hits per question, ordered `timestamp DESC`.
  `core/schemas.ts` carries 41 commits, so any traversal touching it returns a
  recency-ordered list with no relevance signal. Degrades as memory grows.
- By-meaning ranks the correct commit first in 6 of 10 questions, second in 3
  more.

## Result 2 — against an agent that already has git

Baseline: same agent with `git log`, `git show`, `git blame`, `git grep`, able
to mine the same commits the memory was built from.

| | git-only baseline | with memory |
|---|---|---|
| Mean score | 0.93 | **1.00** |
| Fully answered | 8 / 10 | **10 / 10** |
| Cited the right commit | 0.90 | 0.90 |
| **Mean turns** | 7.7 | **1.4** (−82%) |
| Mean duration | 21.7s | **9.7s** (−55%) |
| Cost, 10 questions | $0.717 | **$0.380** (−47%) |

9 of 10 memory answers took a single turn with no tool calls; the baseline
needed 3–16 turns of history archaeology for the same explanation.

Per-question turns, git-only → memory:

```
jit-leak            7 → 1     anchor-helper       7 → 1
proto-record        6 → 1     prototype-methods   3 → 1
xor-matches        16 → 1     catch-optin        14 → 1
domain-lookahead    4 → 5     iso-cycle           9 → 1
base64-revert       5 → 1     tuple-length        6 → 1
```

`domain-lookahead` is the control: the only question where by-meaning missed
the answering commit, and the only one where memory made the agent slower
(4 → 5 turns). Retrieval quality decides whether context is an asset or a debt,
matching the earlier benchmark; the correlation holds both directions.

## Reading of the accuracy number

- The 0.93 → 1.00 gap is the weakest claim here; do not rely on it. Grading
  counts synonym groups drawn from the real commit message, which the memory
  condition is handed, so hitting those words is easier for it.
- Baseline miss 1, a genuine gap: explained the prototype-methods memory win,
  never mentioned the bundle-size regression that came with it.
- Baseline miss 2, a wording difference: explained `__proto__` skipping as
  prototype pollution (correct) without the `JSON.parse` origin the commit
  gives.
- **Robust finding is efficiency, not accuracy:** 5.5× fewer turns, 47% lower
  cost, against an agent that could and did find the same answers itself. The
  knowledge is recoverable on demand but expensive; the memory precomputes it.

## Conclusion on direction

Same system, two jobs:

| | code location | recorded reasoning |
|---|---|---|
| Baseline to beat | grep, ~2–3 turns | git archaeology, ~8 turns |
| Result | **loses** (0.46 vs 0.67 recall) | **wins** (−82% turns) |

Value comes from holding knowledge absent from the code and expensive to
reconstruct, not from finding files faster than grep. Changes the evidence
supports, in order:

1. **Build the capture layer.** It does not exist. Git history is the cheapest
   source and present in every repo; session-end capture and PR review threads
   are next, both provenance types already declared in the spec.
2. **Retrieve knowledge by its own content**, code binding used to enrich and
   rank rather than gate. Node-gated hydration ordered by recency degrades as
   memory fills.
3. **Give experiences a text index.** The current schema cannot search them.

## Limitations

- **n = 10 questions, one repo, single runs.** Trend, not statistics.
- **Lexical retrieval, not embeddings.** No embedding API here, so by-meaning
  uses Postgres full-text ranking. A real embedder should only raise it, making
  0.75 MRR a floor, not a ceiling.
- **Questions were written by reading the answering commits.** Real questions
  about real decisions, but a developer hitting these problems organically
  might phrase them with less overlap with the commit text.
- **Only commit messages were mined.** PR discussion, review comments and
  session history — likely richer sources of "why" — were not touched.
- **zod has unusually good commit messages.** A repo of low-information commit
  messages would yield far less. Re-run on a repo with mediocre history before
  generalising.

## Reproducing

```bash
git clone https://github.com/colinhacks/zod.git /tmp/zod   # full history, not --depth 1
export ZOD_DIR=/tmp/zod
export DATABASE_URL="postgres://postgres:postgres@localhost:5432/cognitive_memory"

# needs the e2e benchmark's zod graph already ingested (BENCH_TARGET=zod bench:ingest)
pnpm --filter @cognitive-memory/eval-why-spike build
pnpm --filter @cognitive-memory/eval-why-spike spike:capture
pnpm --filter @cognitive-memory/eval-why-spike spike:probe
pnpm --filter @cognitive-memory/eval-why-spike spike:compare   # needs `claude` CLI
```
