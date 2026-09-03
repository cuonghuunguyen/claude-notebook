# Benchmarks

Append-only log of `.claude/skills/self-improve/SKILL.md` cycles. Each row
is one *measured* improvement — what changed, exactly how it was measured
(reproducible by a human, not just asserted), the before/after numbers, and
the PR that shipped it.

Never edit or delete a past row. If a later cycle finds a prior
"improvement" regressed or was measured wrong, add a new row noting it —
this file is a history, not a current-state snapshot.

| Date | Area | Change | Metric (how measured) | Before | After | PR |
|------|------|--------|------------------------|--------|-------|-----|
| 2026-08-10 | Correctness/robustness + performance | `extractChangedFiles` in `packages/structural` and `packages/structural-python`'s `incremental.ts` batched all of one incremental call's node deletions into a single Postgres transaction, instead of opening one connection checkout + one transaction per deleted node. Fixes a real atomicity gap (a crash mid-loop could leave a file's deletions half-applied) and removes the per-node connection overhead. | `vi.spyOn(getPool(), "connect")` around an `extractChangedFiles` call that deletes 3 functions from one file in a single incremental update; asserted call count, real Postgres (`cognitive_memory_test`). Test added to both packages' `integration.test.ts`. | 5 connect() calls (structural), scaling with deleted-node count | 3 connect() calls (structural), constant regardless of deleted-node count — same pattern verified in structural-python | [#14](https://github.com/cuonghuunguyen/claude-notebook/pull/14) |
| 2026-08-20 | Knowledge retrieval (ROADMAP M11, not a self-improve cycle) | By-meaning retrieval and git-history capture moved out of `eval/why-spike` / `scripts/self-memory.mjs` into `packages/episodic` (`queryByMeaning`: full-text + trigram + vector legs fused by weighted RRF) and a new `packages/capture` (idempotent `captureGitHistory`, `recordScoutReport`), plus migration `0004` giving `experiences` the indexes to be searched by its own content. `runPipeline` now surfaces by-meaning hits in `AgentContext.experiences`. | `eval/why-spike`'s own 10 hand-labelled "why" questions over a full clone of `colinhacks/zod` (`ZOD_DIR=/tmp/zod`, scope `packages/zod/src/v4`), MRR of the commit that actually answers each one. Same questions and same scoring as `WHY_MEMORY_SPIKE.md`, but every retrieval call now goes through the shipped packages. Reproduce: `spike:capture` then `spike:probe` (add `SPIKE_EMBEDDER=fake` for the vector leg). **Three controls were run on separate fresh databases**, because two things besides the port changed and a single number could not tell them apart: (a) the original repair-only `isExplanatory` vocabulary, (b) the widened repair+decision vocabulary that ships, (c) the widened vocabulary with `recordExperience`'s timestamp persistence reverted to master's behaviour. | by-meaning MRR **0.75**; node-gated MRR **0.13** (spike code, `WHY_MEMORY_SPIKE.md`, on a 103-commit corpus) | by-meaning MRR **0.85** lexical-only / **0.90** with the stub embedder, recall 0.90 (9/10). Identical (0.85) under control (a), so the vocabulary widening is measurably neutral here — it added 2 commits to this corpus, not the 34 the corpus grew by; the rest is zod's own history having grown since the spike (103 → 135 explanatory commits in scope). Node-gated re-measured at **0.00**, and it is 0.00 under all three controls — including (c), which rules out the timestamp fix as the cause. What remains is corpus growth against a `LIMIT 10` newest-on-this-file window: as a file accumulates commits, the one that explains a decision falls out of the window. That is the structural weakness §24 is about, not a regression introduced here. | merged directly to `master` (explicit human override of the PR flow — no PR) |
| 2026-08-20 | Knowledge-link edges (ROADMAP M14 spike — go/no-go, not a self-improve cycle) | Nothing shipped into `packages/`. `eval/link-spike` mines candidate memory-to-memory edges from **git metadata only** (`reverts` / `shares_issue` / `follows_up`), hand-checks their precision on a labelled sample, and runs a budget-fair A/B against the shipped M11 by-meaning retrieval on 10 questions whose ground truth spans **two** commits. Verdict: **NO-GO on integrating a memory-link layer now** — real but underpowered win (n=10, p=0.125), confined to 2 of 3 relations covering 27% of memories; `follows_up` a hard no at precision 0.00 (population-weighted miner precision 0.301, not the 0.52 stratified mean). An independent review pass then found the displaced context slots were worthless by construction (no gold slot at ranks 3-6) and the baseline ran with 0 embeddings, so the headline is not quotable on its own. See the prose section below the table for the full threat list. | Corpus `colinhacks/zod @ 870433f3`, scope `packages/zod/src/v4`, 400-commit window (376 commits after capture's filters, 137 recorded as memories), DB `cognitive_memory_m14`. **Precision:** 25 pairs sampled seeded-stratified from the *memory-to-memory* subset (the only edges retrieval could ever traverse), each labelled by reading both commits' full messages via `git show -s`, criterion + per-pair justification in `labels/precision-labels.json`; scored by `dist/sample.js`, never typed by hand. **A/B:** equal context budget (K=5: arm B spends 3 slots on by-meaning rank and 2 on 1-hop neighbours, so a linked memory must *displace* a by-meaning hit), metric = fraction of questions where **both** gold slots are retrieved. Reproduce: `ZOD_DIR=/tmp/zod node dist/sample.js && node dist/probe.js`. | by-meaning (M11 product), K=5: **bothSlots 0.60** (6/10), slot recall 0.80. Random-rewired control, same budget, 20 substitutions: **0.60**. | linked 1-hop, K=5: **bothSlots 0.90** (9/10), slot recall 0.95. Strong-relations-only (`follows_up` dropped): **0.90** on ~half the edges. Precision: `reverts` 1.00 (n=1), `shares_issue` 1.00 (n=12), `follows_up` **0.00** (n=12), overall 0.52. | no PR — branch `milestone/M14-knowledge-links-spike` (explicit human override of the PR flow) |
| 2026-08-21 | Decommissioning the structural graph (ROADMAP M15 — the gate, not a self-improve cycle) | **Gate first, deletion second.** Before anything was removed, `eval/why-spike`'s 10 hand-labelled "why" questions were re-run through the knowledge-first pipeline in a **2×2 ablation**: structural graph fully ingested vs. `nodes`/`edges` empty, each lexical-only and with the stub embedder, on four separate fresh databases. The gate's question was not "is by-meaning good" (M11 answered that) but "does *anything* still measurably depend on structural nodes". It does not — the two node conditions are numerically identical, and the node-gated arm is 0.00 in both. So `packages/structural`, `packages/structural-python`, `packages/traversal`, `packages/semantic` and `packages/retrieval` were removed, along with `graph-store`'s `nodes.ts`/`edges.ts`, `staleness`'s §12 edge verifier, `gc`'s edge-based cold rule, `episodic`'s `queryByNode`, `context`'s four code sections, `core`'s `Node`/`Edge`/`RelationType`/`nodeId()`, and `eval/retrieval`, `eval/staleness`, `eval/traversal-cost` and `eval/e2e-benchmark`'s harness. `runPipeline` lost its whole seeds→traverse→hydrate stage. `migrations/0008` drops `edges` then `nodes`. ~10,300 lines deleted, ~1,000 added. | Corpus `colinhacks/zod` @ `e516c3ba`, scope `packages/zod/src/v4`, 142 explanatory commits captured as memories by the shipped `packages/capture`. Metric = MRR (and recall) of the commit that actually answers each of the 10 questions, scored by `dist/probe.js`, never typed by hand. The "with nodes" arm ingests the real ts-morph graph first (`eval/e2e-benchmark`'s `ingest.js`: 501 nodes in store, 1171 edge rows) so the node-gated arm has a genuine graph to seed and traverse; the "without nodes" arm leaves `nodes` empty. Reproduce (pre-removal, at `origin/master`): `ZOD_DIR=/tmp/zod node eval/e2e-benchmark/dist/ingest.js && node eval/why-spike/dist/capture.js && node eval/why-spike/dist/probe.js`, adding `SPIKE_EMBEDDER=fake` for the vector leg, on a fresh database per arm. Post-removal: same two `why-spike` commands, no ingest (there is nothing to ingest with). DBs `cognitive_memory_m15_gate_{nodes,nonodes}[_vec]` and `cognitive_memory_m15_post_{nonodes,vec}` on the dedicated M15 Postgres. | **Pre-removal, WITH the structural graph** (501 nodes / 1171 edges): by-meaning MRR **0.85** lexical-only, **0.90** with the stub embedder, recall **0.90** (9/10) in both; node-gated **MRR 0.00, recall 0.00** — it returned 10 memories for every one of the 10 questions and the answering commit was in none of them. **Pre-removal, WITHOUT any structural node** (`nodes` empty): by-meaning MRR **0.85** / **0.90**, recall **0.90**; node-gated returned **0 hits** for every question, MRR **0.00**. The two conditions differ in no digit. | **Post-removal** (packages gone, migration 0008 applied, `nodes`/`edges` tables dropped): by-meaning MRR **0.85** lexical-only, **0.90** with the stub embedder, recall **0.90** (9/10) — identical to both pre-removal conditions and to M11's recorded baseline. The same question misses in every arm (`domain-lookahead`), i.e. the failure is a property of the corpus, not of the removal. `pnpm -r build`, `pnpm -r typecheck`, `pnpm lint` and `pnpm -r test` green with the packages gone: **292 tests, 12 packages** (was 399 tests, 20 packages). Data preservation proved on a *populated* database: 144 memories before and after 0008, identical `md5(id‖task‖observation)` content hash, `anchors`/`related_nodes`/embeddings untouched, `events` intact (1,903 pre-M15 structural rows kept), and `rebuildFromEvents` on that legacy log replays 144 memories to the same hash while skipping 1,903 retired events. | no PR — branch `milestone/M15-decommission-structural` (explicit human override of the PR flow) |
| 2026-08-21 | Storage backend: port to SQLite (ROADMAP M17 — the port gate, not a self-improve cycle) | `packages/graph-store` rewritten off `pg` onto `better-sqlite3` (spec.md §25): one SQLite file replaces Postgres+pgvector+pg_trgm, eight migrations collapse into one rewritten baseline, the full-text leg becomes an external-content FTS5 table ranked by `bm25()`, the vector leg becomes Float32 BLOBs with cosine in JS and no vector extension, and the trigram leg becomes an exact JS reimplementation of `pg_trgm`'s `word_similarity`. Both `pg_advisory_lock` uses, the `FOR UPDATE` supersede lock, the `pg_trgm` GUC, `scripts/setup-dev-db.sh`, CI's service container and `DATABASE_URL` itself are deleted rather than ported. `fuseLegs()` untouched, as §25.3 requires. | `eval/why-spike`'s 10 hand-labelled "why" questions over `colinhacks/zod` (`ZOD_DIR=/tmp/zod`, scope `packages/zod/src/v4`), 142 explanatory commits captured by the shipped `packages/capture`, MRR of the commit that actually answers each question, scored by `dist/probe.js` and never typed by hand. **The Postgres baseline was measured first, on this branch's own parent commit**, so before/after is the same corpus and scorer rather than a quote from an earlier row. Per-leg fidelity was then compared against Postgres directly instead of being inferred from the fused number: the trigram leg over the FULL cross product (10 x 142 = 1,420 pairs, pg values read out of `word_similarity()`), the vector leg by top-20 order per question, the full-text leg by rank of the answering commit. Reproduce: `pnpm -r build && MEMORY_DB=/tmp/x.db ZOD_DIR=/tmp/zod node eval/why-spike/dist/capture.js && MEMORY_DB=/tmp/x.db ZOD_DIR=/tmp/zod node eval/why-spike/dist/probe.js` (`MEMORY_DB` is required for a harness — see spec.md §25.8), adding `SPIKE_EMBEDDER=fake` for the vector arm. | Postgres 16 + pgvector + pg_trgm, re-measured on this branch's parent: by-meaning MRR **0.85** lexical-only, **0.90** with the stub embedder, recall **0.90** (9/10, missing `domain-lookahead`). Trigram leg ablation on the same database: dropping it takes MRR to **0.75**. Install cost **621 MB** (`pgvector/pgvector:pg16`) behind a Docker daemon, a free port, two `CREATE EXTENSION`s and a `DATABASE_URL`. | SQLite: MRR **0.883** lexical-only, **0.933** with the stub embedder, recall **1.00** (10/10). **The gate number moved, upward, and is reported rather than re-baselined** (spec.md §25.8): the trigram leg is identical (1,386 of 1,420 pairs exact, 34 differing by ≤0.0073, zero threshold crossings, same hits in the same order for all 10 questions), the vector leg is identical on 9 of 10 questions and differs only at rank 20 of 20 on the tenth, and the whole movement is the full-text leg — `ts_rank` and `bm25()` rank the same candidates differently. `domain-lookahead`'s answering commit ranks 24th of 36 under `ts_rank` (outside the leg's `LIMIT 20`) and 1st under `bm25()`; `base64-revert` regresses 1 → 3. Install cost **0**: no image, no daemon, no `DATABASE_URL`, no CI service container; **1.3 MB** on disk for 142 memories (2.1 MB with embeddings), `sync` on this repo 181 ms. Retrieval on 142 memories: FTS5 2 ms, vector 2 ms, trigram 107 ms, `queryByMeaning` ~103 ms — the trigram scan was **3.9 s** before three exact pruning bounds, and is now the leg that will hit §25.7's scale ceiling first. Gate: 403 tests across 12 workspaces, **nothing skipped** (there is no `DATABASE_URL` to skip on), plus lint and typecheck. Both arms were **re-measured after the review pass's eight fixes** and reproduced exactly (0.883 / 0.933, recall 1.00), so the fixes are attributable as correctness rather than as retrieval movement. | PR #21 |
| 2026-08-27 | Knowledge retrieval (re-measurement of `WHY_MEMORY_SPIKE.md`, not a self-improve cycle) | Nothing changed in `packages/`. Re-ran the why-memory A/B on the post-M17 SQLite backend with a stronger agent: 20 Sonnet workers (`claude -p --model sonnet`, one per question × condition) launched as Orca terminals in `/tmp/zod`, orchestrated and blind-graded (A/B labels hidden) by a Fable 5 judge, every cited commit checked against `git log`. | `eval/why-spike` 10 "why" questions, fresh scratch DB (`MEMORY_DB=/tmp/why-spike.db`, `spike:capture` → 165 commits, `spike:probe`), baseline = agent with full git access; per-run `num_turns`/`total_cost_usd`/`duration_ms` from `--output-format json`. Raw: `eval/why-spike/results/compare-sonnet-2026-08-27.json`. | Retrieval (M15 gate, 142 commits): recall 0.90, MRR 0.85. Agent (haiku, `WHY_MEMORY_SPIKE.md`): git-only 7.7 turns → memory 1.4 turns, −47% cost. | Retrieval: recall **1.00**, MRR **0.88** (`domain-lookahead`, the one prior miss, now rank 1; `base64-revert` rank 3). Agent: git-only **6.5** turns / $0.211 / 23.9 s → memory **1.8** turns / $0.121 / 9.3 s per question (−72% turns, −43% cost, −61% wall). Accuracy: 20/20 cite the ground-truth commit, 20/20 correct on the mechanism (judge), keyword groups 9/10 vs 10/10 full. Memory did not slow any question; `anchor-helper` tied at 5 turns (memory hit ranked #2, agent verified in source anyway). Two facts from prior runs did not reproduce with Sonnet: no accuracy cost, and the baseline is faster than haiku was (6.5 vs 7.7 turns), so the relative gain shrank from 5.5× to 3.6×. n=10, single run per cell. | none (measurement only) |
| 2026-08-27 | Code-change tasks (re-measurement of `E2E_BENCHMARK_MULTI_REPO.md` Finding 6 on the knowledge-only system, not a self-improve cycle) | Nothing changed in `packages/`. 5 seeded regressions in zod v4 (worktree at the fix commit's parent, so the fix is not in git history): base64 whitespace, looseRecord closed-key pass-through + `__proto__`, closed-tuple `minItems`/`maxItems`, JIT swallowed-issue value leak, domain length limits. Sonnet worker gets the symptom only, may edit source, may not run tests. Graded by applying the fix commit's test files and running vitest. | 10 Orca-terminal workers (`claude -p --model sonnet`), bare vs memory (`queryByMeaning(symptom)` top-5 from the 165-commit corpus; answering commit at rank 1 on 4/5 tasks, rank 2 on base64). Raw: `eval/why-spike/results/codefix-sonnet-2026-08-27.json`. | Prior (M9 graph context, lodash, fix site in context 0/5): bare 3/3, 13.0 turns; memory 3/3, 12.0 turns — neutral. | bare **4/5** pass (tuple fix broke 3 `tuple with rest` tests), 86 turns / $2.03 / 403 s total; memory **5/5** pass, 55 turns / $1.49 / 241 s (−36% turns, −26% cost, −40% wall). Per task turns bare→memory: tuple 35→13, record 14→9, jit 20→16, domain 12→11, base64 5→6. Gain concentrates where the fix is multi-branch (tuple, record, jit); one-line fixes are neutral. Difference from prior run: the context now contains the fix site, because recorded knowledge is the explanatory commit itself. n=5, single run per cell. | none (measurement only) |
| 2026-08-27 | Dogfood memory on this repository (first measurement, not a self-improve cycle) | Nothing changed. 6 "why" questions whose answers live in commit bodies of `54a5f63`, `6be2099`, `d1853ab` (DATABASE_URL hook bug and its 5433 port choice; trigram leg as JS `word_similarity`; `withTransaction`/`closeDb` defect; which leg moved the M17 gate; the min/max trigram bound). Sonnet worker in this repo with Read/Grep/Glob + git; memory = `scripts/self-memory.mjs ask` output injected. | 12 Orca-terminal workers, blind A/B judged, every cited commit checked. Corpus: 43 memories after `sync`. Raw: `eval/why-spike/results/selfrepo-sonnet-2026-08-27.json`. | — | git-only 4.2 turns / $0.152 / 17 s, **5/6 correct** (trigram-bound answer described a different defect); memory 2.8 turns / $0.132 / 14 s, **6/6 correct** (−33% turns, −13% cost). Smaller gain than on zod because this repo's docs (`spec.md` §25.8, `BENCHMARKS.md`) already hold most of the reasoning and grep finds it in 3–4 turns. Product ceiling found: `ask` prints only the first 14 lines of each memory (`scripts/self-memory.mjs:153`), so for 3/6 questions the deciding sentence of the 8 KB M17 commit body was cut from the context; the memory worker still answered from code comments/spec. n=6, single run per cell. | none (measurement only) |
| 2026-08-28 | Retrieval calibration on a real prompt stream (harness in the private `claude-notebook-benchmark` repo) | Four changes, one PR. (1) `createFakeEmbedder` drops stopwords and <3-char tokens before hashing (`EMBED_STOPWORDS`, shared with `toExperienceTsQuery`); migration `0002` nulls stored vectors so `sync` re-embeds. Before it, the cosine between any long prompt and the longest commit body was ~0.6 regardless of topic — the vector leg was a length detector. (2) `queryByMeaning` gets `minVectorScore`: top cosine below the floor → `[]`; CLI sets 0.2. (3) `fuseLegs` multiplies the fused score by `lengthPrior` = 1/(1+ln(len/2000)) for bodies over 2,000 chars, next to the tier boost. (4) CLI `ask`: 3 hits, 3,000-char shared body budget in rank order, and one base-rate line instead of per-hit `possibly-stale` banners when more than half the corpus is flagged. Hooks honour `CLAUDE_NOTEBOOK_BIN`. | 19 real prompts taken from a private work repository's own Claude Code transcripts (15 on-repo, 4 off-repo), that repo pinned at one commit, 215 mined memories. Offline: `calib.py` (hits, injected chars, hub appearances, top hit). Agent: `run.py` — Sonnet, read-only tools + git in both arms, the only difference is the `UserPromptSubmit` hook; `judge.py` — Opus, blind pairwise, arm order randomised. Baseline arm reused from the uncalibrated run (same clone, same settings). Harness and raw per-prompt JSON live in the private `claude-notebook-benchmark` repo, because every result file carries that project's prompts, commit bodies and answers. | Hook fired 19/19; off-repo prompts 4 hits each; the corpus's longest commit body (21,751 chars) in the injection for 8/19 prompts; median injected 8,970 chars (max 36,429); memory cited in 4/19 answers. Agent medians baseline → memory: turns 4 → 4, cost $0.131 → $0.175 (+34%), wall 18.9 s → 34.8 s. Judge baseline/memory/tie 11/7/1. | Hook fired 11/19; off-repo prompts **0 hits** (4/4, each now cheaper than before and 3/4 cheaper than baseline); that body in **0/19**; one hub memory still ranks first, on the single prompt that names its subject; median injected **3,922** chars. Agent medians memory arm: turns 5, cost **$0.173** (flat; still +32% vs baseline), wall **21.4 s** (−38%, baseline 18.9). Judge **11/6/2** — unchanged; three of the six "memory wins" are prompts where nothing was injected, i.e. noise between identical arms. Cost of a fired prompt is not driven by injected size: cutting it 56% moved cost 1%. The 8 prompts that lost hits (the 4 off-repo ones, plus 4 on-repo UI/infra tasks) had 0 citations before. n=1 per cell; single-run cost variance is ±0.4 on two prompts (#5, #26). **Verdict: the retrieval targets are met and the waste on off-repo prompts is gone, but on this prompt stream the plugin still does not pay for itself — the earlier 7.7 → 1.4 result holds only for questions whose answer is known to sit in the corpus.** | this PR |
| 2026-08-28 | Distilled memories (spec §26 / ROADMAP M19 — an experiment with a stated null hypothesis, not a self-improve cycle) | `experiences` gains a derived `digest` column (migration `0003`). After capture, `sync` sends each memory's task, body and anchor paths to `claude -p --model haiku` (`packages/capture/src/distill.ts`, injected runner, 4-way concurrent, `--allowedTools ""`) and stores a ≤120-word `What:`/`Why:`/`Where:` summary. All three retrieval legs, the FTS5 generated column and its triggers, the embedding text and `fuseLegs`' length prior move to `coalesce(digest, observation)`; `ask` renders the digest, `show` prints both. `observation` is never modified — nulling the column reverts the system. Distillation is off unless `CLAUDE_NOTEBOOK_DISTILL=1` is set, per §26.6's verdict; a missing `claude` binary degrades to raw-body retrieval per memory. | Same 19 real prompts, same clone (the same private work repository at the same commit, 215 memories), same scripts as the row above: `calib.py` offline, `run.py` (Sonnet, read-only tools + git in both arms, only the `UserPromptSubmit` hook differs), `judge.py` (Opus, blind pairwise, arm order randomised). **The baseline arm is the same reused `*-off.json` set as the row above**, which is what the control below exposes. Distillation: 212 of 215 memories digested over 3 `sync` passes (115+82+5 distilled, 85+8+3 skipped — the 85 were a usage-limit window, the residual 3 persistently exceed the 1,200-char cap and keep the raw-body fallback), 29m26s wall, ~313 `claude` calls at a measured $0.027 median each ≈ **$8.4** — dominated by the CLI's own ~30k-token system prompt, not by the memory being summarised. Raw: `results/*-on-distilled.json` and `judge-distilled.json` in the private `claude-notebook-benchmark` repo. | Calibrated-undistilled (the row above, re-tabulated on the same three-arm script): hook fired 11/19, median injected **3,922** chars; agent medians over all 19 turns **5** / cost **$0.173** / wall **21.4 s**; over the 11 fired prompts turns **6.5** / cost **$0.256** / wall **24.5 s**; memory cited in **4/19** answers; judge off/on/tie **11/6/2**. Baseline (grep+git) medians: turns **4**, cost **$0.131**, wall **18.9 s**; over those same fired prompts turns **6.5**, cost **$0.171**, wall **24.5 s**. | Distilled: hook fired 12/19, median injected **3,167** chars (−19%); agent medians over all 19 turns **4** / cost **$0.179** / wall **21.6 s**; over the 12 fired prompts turns **4.5** (baseline 6.5, calibrated 6.5) / cost **$0.244** (baseline $0.171) / wall **33.7 s** (baseline 24.5 s — worse); memory cited in **2/19** answers (calibrated 4/19 — worse); off-repo waste regressed (prompt #10 regained 3 hits where the calibrated arm had 0). Judge off/on/tie **4/14/1**. **That judge flip is NOT attributable to distillation and is reported as uninterpretable rather than as a win.** The control: on the 7 prompts where the hook did not fire the two arms are configuration-identical, and the judge picked the memory file **6 times, tied once, baseline zero** — where the calibrated run's same control was a balanced 3/3/2. The noise floor moved between the two runs (the baseline files are hours older than the distilled ones), so the 8/4 split on the 12 fired prompts sits inside that drift. **Verdict: does not clear spec §26.5's bar. M19 stays unchecked.** Distillation buys a smaller injection (−19%) and fewer turns on fired prompts (6.5 → 4.5), and costs a halved citation rate (4/19 → 2/19), 38% more wall time on fired prompts, $8.4 of one-time spend, and a per-memory LLM dependency the system did not previously have. On this prompt stream it still does not beat grep+git on cost (+43% on fired prompts). n=1 per cell; two prompts (#5 $2.28, #26 $1.96) are single-run outliers that dominate the totals, which is why medians are quoted. | this PR |
| 2026-09-03 | Correctness — the vector leg becomes real (root cause of the 2026-08-28 floor) | `createLocalEmbedder` (`@huggingface/transformers` + `onnxruntime-node`, `Xenova/all-MiniLM-L6-v2`, 384-dim, no key and no daemon) replaces `createFakeEmbedder` as the CLI's embedder; the stub stays and every test still uses it. CLI floor 0.2 -> 0.3. Migration `0004` nulls vectors so `sync` re-embeds. **Why this is the root cause and not a re-tune:** feature hashing makes cosine track how RARE a question's words are, not whether the corpus answers it, so no floor could separate relevant from irrelevant. One question against this corpus, hash -> real: cosine to the memory that ANSWERS it 0.1937 -> 0.5554, to an unrelated memory 0.1865 -> -0.0178 — a 0.007 separation becomes 0.57. (That pair is n=1 and is illustrative; the 32-question sweep below is the evidence.) **A second defect was found while measuring:** the model truncates SILENTLY, so long memories were embedded from their opening only. `chunkForEmbedding` splits on whitespace and `meanPool` averages the chunk vectors, keeping one vector per memory (no schema change). | 32 questions against this repository's live 145-memory corpus after `sync`: **16 on-repo** (the answer is a documented decision here) and **16 off-repo** (unrelated technology), each set half natural-language and half keyword/identifier-shaped. That symmetry is deliberate — an earlier version had keyword-shaped questions on the on-repo side only, which put keyword shape in scope for recall and out of scope for leakage, and a review found the leaks lived exactly there. Metric: on-repo ANSWERED (>=1 hit) vs off-repo LEAKED (>=1 hit), swept over the floor. Reproduce: `node scripts/self-memory.mjs sync && node scripts/relevance-gate-probe.mjs` (`FLOORS=...`, `EMBEDDER=fake`). Baseline measured on a COPY of this same corpus re-embedded by the hash embedder in a `git worktree` at `origin/master` — required because `cosineSimilarity` correctly refuses to compare 1536-dim stored vectors with 384-dim query vectors, so the arms cannot share a database. **One off-repo question was corrected mid-measurement and the correction is reported, not banked:** "postgres VACUUM FULL lock" is not a valid off-repo question — this corpus is substantially ABOUT removing Postgres (`pg_advisory_lock`, the `FOR UPDATE` supersede lock, `pg_trgm`), so returning the storage memory for it is correct behaviour. The rule it broke was fixed independently of any result (an off-repo question must concern technology the corpus does not discuss). It was REPLACED, both arms re-measured, and **neither number moved** — the replacement leaks too — so the corrected set counts the same 2/16 with both leaks genuine instead of one being a mislabel. | Hash embedder (master), same 32 questions: floor **0.2 (shipped)** answered **6/16**, leaked **3/16**. Frontier — 0.1: 15/16, 10/16 · 0.2: 6/16, 3/16 · 0.3: 3/16, 0/16 · 0.4: 0/16, 0/16. The hash arm cannot reach zero leakage above 3/16 recall. | Local chunked embedder: floor **0.3 (shipped)** answered **11/16**, leaked **2/16** — better than the shipped baseline on BOTH axes. Frontier — 0.1: 16/16, 13/16 · 0.2: 16/16, 8/16 · 0.3: 11/16, 2/16 · 0.32: 11/16, 1/16 · 0.35: 10/16, 1/16 · 0.4: 9/16, 0/16. Pareto: at ZERO leakage recall goes 3/16 -> 9/16; at FULL recall leakage goes 16/16 -> 8/16. **0.32 measured marginally better (11/16, 1/16) and was deliberately NOT taken** — a two-decimal threshold tuned on 32 questions is how 0.2 became untransferable. **Corrections to this row's own first draft, after an independent review re-measured its claims — every one of these was published wrong and is restated rather than quietly amended:** the model truncates at **512** wordpiece tokens, not 256 (`model_max_length`, and confirmed empirically: a marker appended past 512 leaves the embedding bit-identical), so the affected share of the corpus is **34 of 145 = 23.4%** measured by tokenizing, not the 39% first claimed against a wrong limit (median 204 tokens, p95 3,111, max 6,424); the model download is **87 MB** fp32, not "~23 MB" (that is the quantized variant, which this code does not request); the dependency footprint is **~30 lockfile packages and ~442 MB of node_modules** — `onnxruntime-node` 211 MB, `onnxruntime-web` 129 MB (dead weight in a Node CLI), `@huggingface/transformers` 102 MB — including `sharp`, a SECOND native module and a known install-failure source on musl, not "two new runtime deps, one of them native"; and the suite is **409 -> 418** tests (+9), not the 411 -> 425 first claimed. `EMBED_CHUNK_CHARS` stays at 1,000 but its stated reason was wrong and is now measured: token density on this corpus runs 0.220-0.348 tokens/char, so 512 tokens is 1,469-2,323 chars and 1,000 keeps a ~1.5x margin. It is a bound, not a guarantee — text far denser than anything here (a solid run of hex SHAs) can still cross 512 inside one chunk, marked `ponytail:` in the source with token-based chunking as the upgrade. **Two real bugs the review found in the chunker, both fixed and both now pinned by mutation:** the boundary search used `lastIndexOf(" ")`, so newline- or tab-separated text was cut mid-token at EVERY chunk edge (commit bodies are this corpus's entire content and they wrap on newlines); and a leading run of whitespace could become a chunk of its own (`" ".repeat(50) + body` emitted a 49-space chunk), which an unweighted `meanPool` then counted for as much as a chunk of real prose. Also fixed: `Math.sqrt(norm) || 1` let a NaN through (NaN is falsy), and one NaN-embedded memory makes `best < minVectorScore` false for every query — i.e. it would silently disable the floor corpus-wide; a rejected `pipeline()` promise stayed cached, disabling embeddings for the whole process after one transient fetch failure; and the model cached inside `node_modules/@huggingface/transformers/.cache`, which this repo's SessionStart hook destroys on every `pnpm install` — it now lives in `~/.cache/claude-notebook/models` (override with `CLAUDE_NOTEBOOK_MODEL_CACHE`), which is what makes "no network after the first fetch" true. **Costs, re-measured after those fixes:** full re-embed of 145 memories **40 s** warm (0.28 s/memory), 85 s cold including the download; incremental `sync` with nothing to embed **1.4 s**; stored vector 6,144 -> 1,536 bytes/row. `ask` degrades to lexical-only with a stderr warning when the model cannot load — both halves proved (an unresolvable model throws; `queryByMeaning` with no embedder returns 3 hits on `text+trigram`). **What this does NOT fix, stated rather than left to be discovered:** (1) the floor is still a WHOLE-QUERY veto, so the 5 on-repo questions silent at 0.3 are silenced while FTS5 holds their answer — a fix for that was attempted and rejected on review the same day (CHAIN_LOG). (2) `meanPool` dilutes: the review measured pooled cosine BELOW the best single chunk on all four long memories it tested, and on one (`370f7b1`, 15,525 chars) pooled scores **0.2808 — under the shipped 0.3 floor — where the best chunk reaches 0.3659**. Max-pooling would clear it but needs k vectors per row, which this change explicitly declines; long memories are now damped twice, by pooling and by the pre-existing `lengthPrior`. (3) the gate is inert between the migration that nulls vectors and the `sync` that refills them, because it is skipped when the vector leg is empty. (4) the 32 questions are hand-written by the session that chose the floor; the symmetry fix makes them better, not independent. | [PENDING] |

---

## M15 — Decommissioning the Structural Graph: the gate

**The gate passed, and it passed on an ablation rather than on a re-run.**

ROADMAP M15's wording is "a re-run of the existing eval sets through the
knowledge-first pipeline shows no regression vs the `BENCHMARKS.md` baseline".
Read literally, that is satisfiable by one number: run the eval, compare 0.85
to 0.85, delete. That would have been the wrong measurement, because it cannot
distinguish "the structural graph contributes nothing" from "the structural
graph contributes something and the eval does not see it". A no-regression
re-run of a pipeline that still *has* the structural stage tells you nothing
about what happens when the stage is gone.

So the gate was run as a **2×2 ablation** instead — the graph present vs.
absent, crossed with the vector leg off vs. on, on four separate fresh
databases:

| arm | nodes / edges in DB | by-meaning MRR | by-meaning recall | node-gated MRR | node-gated hits/question |
|---|---|---|---|---|---|
| lexical, graph ingested | 501 / 1171 | **0.85** | 0.90 | **0.00** | 10 |
| lexical, no graph | 0 / 0 | **0.85** | 0.90 | **0.00** | 0 |
| +stub embedder, graph ingested | 501 / 1171 | **0.90** | 0.90 | **0.00** | 10 |
| +stub embedder, no graph | 0 / 0 | **0.90** | 0.90 | **0.00** | 0 |

Two things in that table are the whole milestone.

**The by-meaning column does not move.** Not "moves within noise" — the same
per-question ranks, the same single miss (`domain-lookahead`), the same MRR to
two decimals, with a real 501-node / 1171-edge ts-morph graph of zod v4 sitting
in the database and with the tables empty. Retrieval was not using it.

**The node-gated column is 0.00 with the graph present.** This is the sharper
result, and it is not the same statement as "0.00 because there was nothing to
retrieve". With the graph ingested the arm worked exactly as designed: it
found seeds, traversed, and returned ten memories for every single question.
It just never returned the right one. The pre-M11 design was not
under-provisioned here; it was pointed at the wrong thing. `WHY_MEMORY_SPIKE.md`
diagnosed why — a `LIMIT 10` newest-on-this-file window loses the commit that
explains a decision as soon as the file accumulates commits — and this is that
diagnosis holding at full graph coverage.

### What the gate could have found instead, and why it would have blocked

The gate was written to be failable, and two specific findings would have
blocked the milestone:

- **Capture depending on the graph.** `captureGitHistory` used to take a
  `resolveNodeIds` bridge into `packages/structural`. If anchoring had been
  routed *through* it — if a commit with no resolvable node had been counted
  `unanchored` — then deleting the extractors would have silently emptied the
  corpus. Measured: 142 commits mined, 142 recorded, **0 unanchored**, on a
  database with zero nodes. Anchors were already text; the bridge was additive.
- **`experiences.related_nodes` being node-only.** The obvious "retire the
  node-gating surface" move is to drop that column and its GIN index. Reading
  `listExperiencesByAnchorPaths` shows why that would have been wrong: it
  matches anchors against `anchors` **or** `related_nodes`, because memories
  written before M12 have their anchors only in the latter. Dropping it would
  have made the entire pre-M12 corpus invisible to §24.2.3's staleness pass —
  and this repository's own memory graph is mostly pre-M12. Kept, deliberately,
  and `isNodeId()` kept with it so a legacy 32-hex node id in that column is
  still never mistaken for a file path.

### The post-removal re-run

Same two commands, on a database migrated `0001`→`0008` from empty, with
`nodes` and `edges` never created: **MRR 0.85 lexical-only, 0.90 with the stub
embedder, recall 0.90**. Identical to both pre-removal conditions and to the
M11 row above. 142 commits mined, 142 memories recorded, 142 preserved.

`pnpm -r build && pnpm -r typecheck && pnpm lint && pnpm -r test` green with
the packages gone: 292 tests across 12 packages, down from 399 across 20. The
107 tests that went away tested the removed subsystem; none of the survivors
were weakened to make them pass. An independent review pass diffed every
rewritten test file against `origin/master` and found three net stronger, one
genuine softening (`capture`'s two `SELECT count(*) FROM nodes` assertions
became a format check, which is all that is expressible after 0008), and none
tautological.

### Data preservation, proved rather than asserted

The acceptance criterion "`experiences` data is preserved" was checked against
a *populated* database — the gate's own `_gate_nodes` DB, which had been
migrated to 0007, loaded with 501 nodes / 1171 edges, and had 144 memories:

```
before 0008: nodes=501 edges=1171 experiences=144 anchors_rows=142  md5=b2f9fe43…
after  0008: experiences=144 anchors_rows=142 related_nodes_rows=144 md5=b2f9fe43…
tables after: events, experience_accesses, experiences, schema_migrations
re-run:       "No new migrations to apply."   (idempotent)
events after: ExperienceRecorded 144 | RelationAdded 1401 | SymbolAdded 502
```

And the §14 backward-compatibility case, on a copy of that same legacy log:
`rebuildFromEvents()` → `{ applied: 144, skipped: 1903 }`, with the replayed
corpus hashing to the identical `b2f9fe43…`. A database that ever ran a
structural extraction can still rebuild itself; it just reports that 1,903
projections were dropped rather than pretending the replay was complete.

---

## M14 — Knowledge-Link Edges: the written go/no-go

**Verdict: NO-GO on building the memory-link layer into the product now.**
M14's strong hypothesis — that traversal must pay off here, where it failed for
call graphs, because relations between memories are not in the source at all —
is **not supported by this corpus**. There *is* a real retrieval win
(0.60 -> 0.90) and it does survive a random-rewiring control, but it is
underpowered (n=10, p=0.125), it lives in only 2 of the 3 mined relations
covering 27% of memories, and an independent review pass found two threats that
between them stop the headline being quotable: the slots the link arm displaces
were **worthless by construction of the gold set** (no gold slot sits at ranks
3-6, so the "equal budget" trade-off was never actually priced — T1), and the
baseline ran with **zero embeddings**, i.e. 2 of `queryByMeaning`'s 3 legs
(T2). `follows_up` is a hard no on two independent measurements — precision
0.00 and no contribution to the A/B. `reverts` + `shares_issue` earn one more,
better-designed measurement, not a place in `runPipeline`. Nothing is
integrated into the pipeline by this milestone, and no migration is left
behind.

M14 existed because M5's call-graph traversal lost to grep, and the stated
reason was that grep can reconstruct code relations from source. The claim
under test was that relations *between memories* are different in kind: they
are not in the working tree at all. That claim is now measured rather than
asserted.

### What the miner found

Over 137 memories, 113 candidate memory-to-memory edges, 69.3% of memories
carrying at least one. But the three relations are wildly unequal, and the
aggregate hides it:

| relation | memory-to-memory edges | memories covered | hand-checked precision |
|---|---|---|---|
| `reverts` | 1 | 1.5% | 1.00 (n=1 — **too small to claim anything**) |
| `shares_issue` | 33 | 26.3% | 1.00 (n=12, but see contamination caveat — disjoint n=5) |
| `follows_up` | 79 | 56.2% | **0.00 (n=12)** |
| all three | 113 | 69.3% | **0.301 population-weighted** (0.52 is the stratified mean — see below) |
| `reverts` + `shares_issue` only | 34 | **27.0%** | 1.00 (n=13) |

**The 0.52 figure is not the miner's precision, and an earlier draft of this
row wrongly implied it was.** The sample is stratified *equal-n* (12 + 12 + 1),
so an unweighted mean over strata over-weights the single-edge `reverts`
stratum ~79x and under-weights `follows_up`, the relation that dominates the
real edge set. Re-weighting each stratum's measured precision by its share of
the 113 memory-to-memory edges gives **0.301** (~34 of 113 edges related) —
0.22 *worse* than the stratified mean, i.e. the convenient number was the
flattering one. `sample.ts` now computes both and labels which to quote; as
with every other figure here, neither is typed in by hand.

`follows_up` — "same file, within 14 days", 70% of all mined edges — scored
**zero** on 12 hand-read pairs. Every one was co-occurrence: two commits
touching a hot file in the same release train, with nothing to do with each
other. That rule is not a weak signal, it is not a signal.

### What the A/B found

Equal budget, K=5, 10 two-slot questions. Arm B must *displace* by-meaning
hits to spend slots on links, so this measures substitution, not "more context
beats less context":

| arm | bothSlots | slot recall | edges traversed |
|---|---|---|---|
| by-meaning (M11 product) | 0.60 | 0.80 | 0 |
| **linked, 1-hop** | **0.90** | **0.95** | 18 |
| strong-relations only | 0.90 | 0.95 | 10 |
| **random-rewired control** | **0.60** | **0.80** | 20 |
| unbudgeted (ceiling) | 0.90 | 0.95 | 83 |

Two controls carry what conclusion there is; the third cell turned out to be
uninformative and is listed for completeness:

1. **Random rewiring stays at by-meaning's score** while spending the *same*
   budget on the *same number* of substitutions — 20 vs 18 — pointed at real
   memories, not at commits capture never recorded (that distinction is why
   `allMemoryShas` exists; rewiring to arbitrary commits would have made the
   control degenerate into the by-meaning arm and lose by construction). Swept
   over 6 seeds it scores 0.60, 0.60, 0.70, 0.60, 0.60, 0.60 — never once
   approaching 0.90. **The neighbour's identity is doing the work, not the
   act of adding a neighbour.** This is the single most important number in
   the milestone. Scope it honestly, though: the control is not *inert*, it is
   *unhelpful on average*. It rises to 0.70 on one seed by luck (14% of the
   rewiring pool is a gold memory), reaches 0.80 at K=13 and K=20, and falls
   to **0.10** at K=3/`seedCount=1`, where displacing good ranks genuinely
   costs. The flat-0.60 reading holds inside the swept K=5...10 /
   `seedCount=3` band, not everywhere.
2. **Dropping `follows_up` costs nothing** (0.90 either way, on 10 edges
   instead of 18). Two independent measurements — hand-checked precision 0.00
   and zero contribution to the A/B — agree that the rule is dead weight.
3. **The subset whose gold pair the miner does *not* link does not move**
   (0.50 -> 0.50, n=2) — but this is an *uninformative* cell, not a third
   control, and an earlier draft oversold it. On both of those questions
   **every** arm scores 0.50: one is answered by ranks 1-2 alone, the other by
   nothing at all. A cell where no arm can move cannot demonstrate that the
   link arm does not manufacture wins. Reported for completeness only.

A budget sweep reframes the size of the win, and one honest correction has to
come with it. Across K=3...10 the linked arm holds 0.90 and by-meaning climbs
0.60 -> 0.80 — **but only if `seedCount` is retuned alongside K**, which is a
second free parameter. At the *documented* config (`seedCount=3`), K=3 leaves
`expandOneHop` no slots at all: the linked arm traverses zero edges and
collapses to by-meaning's 0.60. So "0.90 at every K from 3 to 10" is only true
of a per-K retuned arm, and is stated that way here rather than as a flat
property of the method.

The durable part of the claim does survive: by-meaning needs **K=13** to reach
0.90, against K=5 for the linked arm — a ~2.6x budget saving — and it never
reaches 1.0 at any budget, because one gold commit (`mac-locale-gap`'s
`3d93a7d5`) falls outside its candidate pool entirely. So links are **not**
retrieving otherwise-unreachable information in general; they are mostly a
**rank-efficiency win**. That is a real benefit for a context-constrained
agent, and a much weaker claim than "memories the product could never find".

### The honest caveat: this is underpowered

Exactly **3 of 10** questions flip, all in the same direction, none against
(`proto-strict-ordering`, `lazy-internals-seal`, `mac-locale-gap`). An exact
one-sided sign test on 3 discordant pairs gives **p = 0.125** — consistent and
mechanistically explained, but *not* significant at any conventional
threshold. `reverts`, the relation with the strongest a-priori story, has
exactly **one** usable edge in this corpus and one label; its 1.00 precision
means nothing yet.

The question set also over-represents linked pairs 8-to-2 by construction
(`questions.ts` documents the discovery path and the skew), which is why the
`goldPairLinked` / `goldPairNotLinked` subsets are reported separately rather
than folded into one number.

### Validity threats an independent review pass found

These are the reasons the 0.60 -> 0.90 headline should not be quoted on its
own. All were found by an adversarial review of this spike's own code and
measured rather than argued; each is reproducible from the harness.

**T1 — "equal budget" is fair in form, but the displacement it charges for is
free on this question set.** Measuring the by-meaning rank of all 20 gold slots
gives `2,1,1,2,9,1,7,1,2,1,MISS,1,2,1,1,2,2,1,1,13` — **not one gold slot sits
at rank 3, 4, 5 or 6**. The linked arm keeps ranks 1-3 and displaces exactly
ranks 4-5, which are therefore guaranteed-worthless *by construction of the
gold set*. So the substitution cannot lose here, and the A/B never actually
tested the trade-off it claims to price. That displacement *can* be expensive
is provable from this same harness: at K=3/`seedCount=1` the random control
scores **0.10**, far below by-meaning. The reported configuration is the one
where displacement happens to be free. **This is the most serious threat to
the headline, and it is why the verdict is a no-go rather than a narrow go.**

**T2 — the baseline is a degraded version of the shipped product.** The corpus
has 137 experiences and **0 embeddings**, so `queryByMeaning`'s vector leg
contributes nothing and the arm labelled "M11 product" is really 2 of its 3
legs (`budget.embedder: "lexical-only"` in `probe.json` records this). M11's
own headline was measured *with* that leg (MRR 0.85 lexical-only vs 0.90 with
the stub embedder). A fair re-run would capture with `LINK_SPIKE_EMBEDDER=fake`
on both sides; until then the baseline is handicapped by an unknown margin.

**T3 — the precision labels are partly contaminated by the question set.** 8 of
25 labelled pairs touch a gold sha and 5 *are* question gold pairs
(`23edf484->91a7d0d1`, `c9ec89e0->9f0a3d81`, `7378e7cd->3d93a7d5`,
`bd6619c0->fd074106`, `9f0a3d81->b1077f05`). Those 8 are 7 `shares_issue` + 1
`reverts` and **zero** `follows_up` — i.e. all of them land in the two strata
that scored 1.00 and none in the stratum that scored 0.00, in exactly the
direction that flatters the miner. The conclusion survives (the 5 uncontaminated
`shares_issue` labels are still 5/5) but the honest independent n for
`shares_issue` is **~5, not 12**.

**T4 — labelling was not blind.** `sample.ts` writes `relation` and `evidence`
into every sample record, and the labeller was the same agent that authored
`questions.ts` and held the hypothesis. A single non-blind labeller producing a
perfectly clean 12/12 vs 0/12 split *along relation lines* is the signature
anchoring produces. The fix is cheap and was not done here: strip
`relation`/`evidence` from the emitted sample and interleave the strata.

**T5 — `follows_up`'s 0.00 is measured on an unguarded version of the rule.**
The rule has a per-*file* fanout guard but no per-*commit* guard, so a
sweeping chore commit radiates edges: `92f47984` ("chore: fail on stacked line
comments") emits **19**, `0a76f3d7` 13, `66a0f34b` 9. The label file diagnoses
this itself. The no-go on `follows_up` stands — it also contributed nothing to
the A/B, an independent signal — but 0.00 should not be read as the ceiling for
a *guarded* version of the rule.

**T6 — question authoring leaked into the seeds, not just the answers.** The
questions are written from the gold commits' own body vocabulary, and
`queryByMeaning`'s text leg is an OR-of-content-words query — which is why
essentially every findable gold slot lands at rank 1-2. That designs out the
failure mode "no correct seed is retrieved, so 1-hop expansion has nothing to
expand from", which is precisely the mode a real agent would hit most often.

### What survives the caveats, and why it is still worth one more measurement

The effect is small-n but it is not fragile: it survives every budget, it
reverses when the edges are rewired, and it concentrates entirely in the two
relations that hand-checking independently scored at 1.00. On `mac-locale-gap`
the by-meaning arm spends ranks 4–5 on unrelated commits and answers only
"what was backfilled"; the linked arm substitutes `3d93a7d5` — *"feat: MAC
address validation"*, the commit that opened the gap — pulled in over a
`shares_issue` edge on `#5440`, and fills the second slot too.

### The sharpest limitation, found by reading the actual contexts

The slot metric counts whether the **commit** was retrieved, and that is not
the same as whether the question could be **answered**. Checking the three
questions that actually flipped, the by-meaning arm's retrieved text *already
cited the missing commit's PR number in prose* in **all three** cases —
`#6354`, `#6429`, `#5440`.

But the three cases are not equally damaging, and lumping them together
overstates it (a first draft of this section did). Counting the distinct PR
references in each by-meaning context:

| question | distinct PR refs in context | the missing gold PR | leakage |
|---|---|---|---|
| `mac-locale-gap` | 9 | `#5440` | **full** — the backfill body states outright that "mac arrived with #5440 (MAC validation) and was missing from 49" locales |
| `lazy-internals-seal` | 12 | `#6429` | bare pointer, one of 12 |
| `proto-strict-ordering` | 18 | `#6354` | bare pointer, one of 18 |

So exactly **one** of the three is a case where an agent handed only the
by-meaning context could plausibly have answered. In the other two the
"pointer already in the text" is a single unresolvable number among a dozen or
more, with no mechanism to dereference any of them — closer to *no*
information than to the answer.

That split makes the mechanism claim *more* defensible, not less. What the
`shares_issue` edge buys is **automatic dereference of a pointer the text
already contains**: `#5440` tells the agent that a commit exists, not what it
said, and following it would otherwise cost another retrieval the agent has no
API for. In 2 of 3 cases that dereference is the whole value; in the third the
prose had already done the work. Note the corollary — the relation is minable *precisely when* such a
pointer exists, which is very likely why `shares_issue` is the relation that
works and `follows_up` (no pointer, pure co-occurrence) is the one that does
not.

So the defensible claim is the narrow one, and it matches the budget sweep:
links **save budget and a hop**, they do not recover knowledge that was
otherwise unreachable. The stronger framing — "relations between memories are
not in the source at all, so traversal must pay off here where it failed for
call graphs" — is *not* what this corpus shows, and M15/§24 should not lean on
it. Whether the pointer-following actually changes an agent's answer quality
is an agent-level question this retrieval-only probe cannot settle; that is
the measurement a follow-up would need.

The narrowing matters as much as the result, and the per-relation coverage
column makes it sharper still: `shares_issue` alone accounts for 26.3% of the
27.0%, so **`reverts` contributes exactly one edge and 1.5% coverage** to this
corpus. The relation with the strongest a-priori story is effectively absent,
and the entire measured effect rests on `shares_issue` — which is precisely
the relation that is minable only because a pointer already exists in the
text. Those two facts belong together: this spike did not really test
"memory-to-memory edges", it tested "follow the issue number", on one repo.

Taken together the two surviving relations cover only **27% of memories**,
against 69% for all three. That is a sparse, high-precision link layer which
helps decisively on about a quarter of memories — not the general
memory-graph traversal §24 sketches. Building it as though it were general
would reintroduce exactly M5's failure mode: a traversal that fires often,
mostly adds noise, and loses to a flat ranked list.

### What would have to be true before this becomes a retrieval default

Ordered by how much each would change the answer:

1. **Fix T1 — make the displacement cost real.** The next question set must
   contain gold slots at the ranks the link arm actually displaces (3-6), or
   the A/B cannot price its own trade-off. Report the gold-rank histogram
   alongside the result; if it is again empty in 3-6, the number means nothing.
2. **Fix T2 — run the baseline at full strength**, with embeddings captured
   (`LINK_SPIKE_EMBEDDER=fake` or a real provider) so the arm labelled "the
   M11 product" is actually all three of its legs.
3. Replicate on a question set large enough to matter (n >= 30) authored
   *without* reading the miner's output *or* the gold commits' own wording
   (T6), and on a second repository — ideally a non-TypeScript one, since the
   miner reads no source and should port unchanged.
4. Re-label **blind** (T4: strip `relation`/`evidence`, interleave strata) and
   **disjoint from the question set** (T3), so precision and the A/B are not
   measured on overlapping pairs.
5. Get more than one `reverts` edge under test. A corpus with a real revert
   history is a better spike target than zod, where `reverts` contributes a
   single edge.
6. Settle the leakage question with an **agent-level** A/B (answer quality, not
   slot fill), since a retrieval-only metric cannot distinguish "retrieved the
   commit" from "could answer the question".
7. Only then decide the schema question §24.4 defers. The spike reads
   `experiences.action` directly and invents no table on purpose, so this
   **no-go leaves no migration behind to unwind**.

Until (1)-(4) land, `follows_up` should not be built at all, and the two
surviving relations should not be wired into `runPipeline` as a default path.
M15's decommissioning decision should treat M14 as **no evidence for** a
memory-graph traversal layer, not as evidence against by-meaning retrieval.

### One line, if you read nothing else

A git-metadata edge miner does produce edges a human agrees with, but only for
`shares_issue` (1.00 precision, disjoint n=5) and only over 27% of memories;
`follows_up` is 70% of the edges at 0.00 and must not be built. The retrieval
win it produces is real, survives a random-rewiring control, and is
**untrustworthy at face value** because the slots it displaces were worthless
by construction (T1) and the baseline was missing a retrieval leg (T2). Verdict
**NO-GO**; the follow-up is a better-designed spike, not an implementation.
