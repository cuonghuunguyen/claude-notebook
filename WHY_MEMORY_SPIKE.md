# Spike: memory of *why*, not memory of *where*

**Run date:** 2026-08-16 · **Branch:** `claude/github-repo-benchmark-61eabd` · **Harness:** `eval/why-spike/` · **Raw data:** `eval/why-spike/results/*.json`

## What this tests

`E2E_BENCHMARK_MULTI_REPO.md` concluded the system loses to grep at finding
code. That benchmark asked 24 questions whose answers were all sitting in a
file — the terrain where search wins by construction.

This spike asks the opposite kind of question: **why is the code like this?**
Why does this branch return early, what did the obvious implementation break,
what was tried and reverted. None of it is recoverable by reading the source.

It also fixes what made the earlier cross-session test vacuous: the memory now
contains real knowledge, mined from the repository's own history.

## Why the memory was empty before

`spec.md` §1 promises an agent can "recover architectural invariants and
**design decisions**" and "recall previous **debugging/fixing experiences**".
§4 declares `git_commit` and `pull_request` as provenance source types. §7–§8
specify the whole promotion lifecycle.

Nothing in `packages/` ever writes one. Grepping for non-test callers of
`recordExperience` / `recordObservation` returns only benchmark harnesses and a
test fixture. `git_commit` and `pull_request` exist as type literals with no
producer anywhere. The only ingestion path is ts-morph reading source files.

So the memory could only ever hold what the code already says — which is
exactly what grep is good at. **The earlier benchmark measured a knowledge
system with an empty knowledge layer.**

There is a second structural tell: the `experiences` table has indexes on
`related_nodes` (gin) and `timestamp`, and none on any text column. The schema
cannot search knowledge by content.

## The capture layer (`src/corpus.ts`, `src/capture.ts`)

Mines zod's git history for commits that *explain themselves* — a body over
200 characters containing reasoning, not a bare "fix typo" whose knowledge is
re-derivable from the diff. Each becomes a real `Experience` through the
shipped `recordExperience`, bound to the file nodes it touched.

| | |
|---|---|
| Commits scanned (touching `packages/zod/src/v4`) | 414 |
| Explanatory commits kept | 103 |
| Recorded as experiences bound to code | **94** |
| Distinct files covered | 91 |

Nothing in `packages/` was modified — the spike is self-contained.

## Result 1 — retrieval: the shipped path buries the answer

Each question has a known commit that explains it, so retrieval is scored
without involving an agent at all.

| | recall | MRR |
|---|---|---|
| **node-gated** — the shipped design (traverse code, hydrate experiences on exactly those node ids) | 0.70 | **0.13** |
| **by-meaning** — match the question against the knowledge text itself | **0.90** | **0.75** |

The shipped path returned 10 hits for *every* question, ordered by
`timestamp DESC`. Once `core/schemas.ts` carries 41 commits' worth of history,
any traversal touching it pulls a recency-ordered firehose with no relevance
signal. **This gets worse as the memory grows** — the opposite of what a memory
layer should do.

Retrieving by meaning ranks the correct commit **first in 6 of 10** and second
in 3 more.

## Result 2 — against an agent that already has git

The baseline here is not grep. It is the same agent with `git log`, `git show`,
`git blame` and `git grep` — it can mine the very commits the memory was built
from. That is the honest bar, and it is a high one.

| | git-only baseline | with memory |
|---|---|---|
| Mean score | 0.93 | **1.00** |
| Fully answered | 8 / 10 | **10 / 10** |
| Cited the right commit | 0.90 | 0.90 |
| **Mean turns** | 7.7 | **1.4** (−82%) |
| Mean duration | 21.7s | **9.7s** (−55%) |
| Cost, 10 questions | $0.717 | **$0.380** (−47%) |

In 9 of 10 questions the memory condition answered in **a single turn**, with
no tool calls at all. The baseline needed 3–16 turns of history archaeology to
reach the same explanation.

Per-question turns, git-only → memory:

```
jit-leak            7 → 1     anchor-helper       7 → 1
proto-record        6 → 1     prototype-methods   3 → 1
xor-matches        16 → 1     catch-optin        14 → 1
domain-lookahead    4 → 5     iso-cycle           9 → 1
base64-revert       5 → 1     tuple-length        6 → 1
```

**`domain-lookahead` is the control that proves the mechanism.** It is the one
question where by-meaning retrieval missed the answering commit — and it is the
one question where memory made the agent *slower* (4 → 5 turns). Retrieval
quality decides whether context is an asset or a debt, exactly as the earlier
benchmark found. The correlation holds in both directions.

## Honest reading of the accuracy number

The 0.93 → 1.00 gap is the weakest claim here and should not be leaned on.
Grading counts synonym groups drawn from the real commit message, and the
memory condition is handed that message — so it is easier for it to hit the
words. Inspecting the two baseline "misses" shows one is a genuine gap (it
explained the prototype-methods memory win but never mentioned the bundle-size
regression that came with it) and one is a wording difference (it explained
`__proto__` skipping as prototype pollution, correct, but did not mention the
`JSON.parse` origin the commit gives).

**The robust finding is efficiency, not accuracy:** 5.5× fewer turns and 47%
lower cost, measured on an agent that could and did find the same answers
itself. The knowledge is recoverable on demand — it is just expensive, and
precomputing it is what the memory is selling.

## What this says about direction

The earlier benchmark and this spike are the same system measured on two
different jobs:

| | code location | recorded reasoning |
|---|---|---|
| Baseline to beat | grep, ~2–3 turns | git archaeology, ~8 turns |
| Result | **loses** (0.46 vs 0.67 recall) | **wins** (−82% turns) |

The value was never going to come from finding files faster than grep. It comes
from holding knowledge that **is not in the code at all** and that is expensive
to reconstruct — which is what you described wanting.

Three changes are what the evidence supports, in order:

1. **Build the capture layer.** It does not exist. Git history is the cheapest
   source and it is already sitting in every repo; session-end capture and PR
   review threads are the natural next two, and both provenance types are
   already declared in the spec.
2. **Retrieve knowledge by its own content**, with code binding used to enrich
   and rank rather than to gate. Node-gated hydration ordered by recency is a
   firehose that degrades as the memory fills.
3. **Give experiences a text index.** The current schema physically cannot
   search them.

## Limits

- **n = 10 questions, one repo, single runs.** Trend, not statistics.
- **Lexical retrieval, not embeddings.** No embedding API here, so by-meaning
  uses Postgres full-text ranking. A real embedder should only raise that
  number, which makes 0.75 MRR a floor rather than a ceiling.
- **Questions were written by reading the answering commits.** They are real
  questions about real decisions, but a developer who hit these problems
  organically might phrase them with less overlap with the commit text.
- **Only commit messages were mined.** PR discussion, review comments and
  session history — likely richer sources of "why" — were not touched.
- **zod has unusually good commit messages.** A repo full of "fix stuff" commits
  would yield far less. Worth re-running somewhere with mediocre history before
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
