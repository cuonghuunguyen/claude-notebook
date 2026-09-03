#!/usr/bin/env node
/**
 * Dogfooding: point this memory system at this repository.
 *
 * What goes in is knowledge: this repo's own commits that explain themselves,
 * recorded as Experiences anchored to the files they touched, plus the scout
 * reports sessions write back.
 *
 * It used to be two halves — that, and every `.ts` under `packages/` and
 * `eval/` extracted into nodes and edges by ts-morph. `WHY_MEMORY_SPIKE.md`
 * measured which half paid: on questions about *why* the code is the way it is,
 * memory cut an agent from 7.7 turns to 1.4 against a baseline that had full
 * git access. `E2E_BENCHMARK_MULTI_REPO.md` measured the other half losing to
 * grep. M15 removed the losing half (spec.md §24), so `sync` no longer parses
 * anything — which is also why it now works for a repository in any language.
 *
 * Usage:
 *   claude-notebook sync             # mine history + staleness pass
 *   claude-notebook ask "why ...?"   # query it
 *   claude-notebook record <json>    # append one experience
 *   claude-notebook scout <file>     # persist a distilled scout report
 *   claude-notebook stale            # re-flag what history overtook
 *   claude-notebook suspects [n]     # what read-repair should look at
 *   claude-notebook show <id>        # one memory, in full, with its chain
 *   claude-notebook verify <id> [at]  # M13: checked, still accurate
 *   claude-notebook supersede <file> # M13: checked, here is the correction
 *   claude-notebook history <id>     # the whole supersede chain
 *   claude-notebook stats
 *
 * As of M11 the capture and by-meaning retrieval this script used to hand-roll
 * live in `packages/capture` and `packages/episodic`. What is left here is the
 * wiring: which repo, which globs, and how the output is printed.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * Which repository to remember: `REPO_DIR`, else the current directory. Nothing
 * here parses source, so the language does not matter (spec.md §24.2 point 7).
 * The database lives next to the repo it remembers (`<repo>/.claude/memory.db`);
 * `MEMORY_DB` overrides.
 */
const REPO = path.resolve(process.env["REPO_DIR"] ?? process.cwd());
process.env["MEMORY_DB"] ??= path.join(REPO, ".claude", "memory.db");
// The bundled CLI carries the migrations next to itself; the workspace build
// finds them at the repo root as before.
const HERE = path.dirname(fileURLToPath(import.meta.url));
if (!process.env["MEMORY_MIGRATIONS_DIR"] && existsSync(path.join(HERE, "migrations"))) {
  process.env["MEMORY_MIGRATIONS_DIR"] = path.join(HERE, "migrations");
}
/**
 * Kept for the `sync` report only. It used to scope the structural graph
 * (`nodes.repo_id`); memories have never been repo-scoped — a single database
 * holds one repo's memory today, and scoping them is a separate decision
 * nothing has needed yet.
 */
const REPO_ID = path.basename(REPO);

const [graphStore, pipelineMod, episodic, capture, staleness, core] = await Promise.all([
  import("@cognitive-memory/graph-store"),
  import("@cognitive-memory/pipeline"),
  import("@cognitive-memory/episodic"),
  import("@cognitive-memory/capture"),
  import("@cognitive-memory/staleness"),
  import("@cognitive-memory/core"),
]);

const { closeDb, getDb, runMigrations } = graphStore;

async function sync() {

  // Our own history, through the shipped capture package. Idempotent by
  // contract (spec.md §24.2.1) — re-running after a merge only records commits
  // that are actually new.
  const t1 = Date.now();
  const embedder = await embedderOrNone();
  // Whole repo, not just `packages/`: the commits that recorded this project's
  // biggest decisions (the spec.md §24 pivot, for instance) touch spec.md and
  // ROADMAP.md at the root, and a subtree-scoped mine cannot see them — which
  // made the most valuable "why" here the part the memory did not have.
  const result = await capture.captureGitHistory({
    repoDir: REPO,
    pathScope: "",
    limit: 500,
    embedder,
  });
  const mined = result.mined;
  const added = result.recorded;

  // spec.md §26 / M19: rewrite each raw commit body into a short what/why/where
  // digest, which is then what every retrieval leg searches and what `ask`
  // renders. After capture, because a memory has to exist before it can be
  // distilled; before the second embedding backfill, because
  // `setExperienceDigest` nulls the embedding so the digest is what gets
  // embedded. `captureGitHistory` already backfilled once at the top of this
  // run, so the re-backfill below is what re-embeds the rows distilled here.
  // Opt-in, not opt-out: §26.6 measured distillation as not clearing its own
  // acceptance bar on the corpus it was tested against, so it does not spend a
  // user's money by default. The column, the migration and the `coalesce`
  // fallback stay because they cost nothing while every digest is NULL.
  let distill = { distilled: 0, skipped: 0 };
  if (process.env["CLAUDE_NOTEBOOK_DISTILL"] === "1") {
    try {
      distill = await capture.distillExperiences({ runner: capture.createClaudeCliRunner() });
    } catch (err) {
      if (err instanceof capture.ClaudeCliMissingError) {
        console.error("distill: skipped — claude CLI not on PATH");
      } else {
        throw err;
      }
    }
  }
  const reembedded = embedder ? await capture.backfillEmbeddings(embedder) : 0;

  // spec.md §24.2.3 / M12: now that history has been mined, flag the memories
  // that history has since overtaken. Runs after capture, not before: a commit
  // mined in this same pass must not flag the memory it just created (capture
  // stamps the commit's own date, and the test is strictly-newer).
  const suspect = await staleness.markSuspectFromHistory({ repoDir: REPO, limit: 500 });

  console.log(
    JSON.stringify(
      {
        repoId: REPO_ID,
        explanatoryCommits: mined,
        experiencesAdded: added,
        distilled: distill.distilled,
        distillSkipped: distill.skipped,
        reembedded,
        knowledgeMs: Date.now() - t1,
        staleness: {
          changedPaths: suspect.changedPaths,
          candidates: suspect.candidates,
          markedSuspect: suspect.marked,
        },
      },
      null,
      2
    )
  );
  await closeDb();
}

/**
 * Relevance floor and render budget. The budget is the 2026-08-28 real-prompt
 * replay's; the floor was re-measured 2026-09-03 against a REAL embedder
 * (BENCHMARKS.md).
 *
 * 0.2 was calibrated against `createFakeEmbedder`, whose cosine tracks word
 * rarity rather than topic. On this repo's corpus that floor answered 6 of 16
 * on-repo questions and leaked 3 of 16 off-repo ones. With
 * `createLocalEmbedder` the same 32 questions give 11/16 and 2/16 at 0.3 —
 * better on BOTH axes. 0.32 measured marginally better still (11/16, 1/16) and
 * was deliberately NOT taken: a two-decimal threshold tuned on 32 questions is
 * how the 0.2 floor became untransferable in the first place.
 */
const MIN_VECTOR_SCORE = 0.3;
const BODY_BUDGET_CHARS = 3000;
const ASK_LIMIT = 3;

/**
 * The local embedder, or `undefined` when its model cannot be loaded.
 *
 * The vector leg is optional by contract — `queryByMeaning` runs full-text and
 * trigram without it, and `captureGitHistory` records memories with a NULL
 * embedding that a later `backfillEmbeddings` fills in. So a first run with no
 * network degrades to lexical-only retrieval instead of failing the command,
 * which is the difference between a slower answer and no answer at all.
 *
 * The warning goes to stderr, which keeps it out of the JSON on stdout that
 * every command's caller parses. It is NOT invisible to an agent:
 * `.claude/hooks/scout-capture.sh` runs `scout` with `2>&1` and interpolates
 * the result into its `systemMessage`, so on that path the warning is shown —
 * which is the right outcome (the agent should know the vector leg is off)
 * but is worth stating rather than claiming stderr is unreachable.
 */
async function embedderOrNone() {
  const embedder = core.createLocalEmbedder();
  try {
    await embedder.embed("warmup");
    return embedder;
  } catch (err) {
    console.error(
      `embeddings unavailable (${err instanceof Error ? err.message : String(err)}) — ` +
        "answering from the full-text and trigram legs only; re-run with network to enable the vector leg"
    );
    return undefined;
  }
}

/**
 * Ask the memory, through the shipped pipeline (spec.md §22).
 *
 * `runPipeline` is what produces the ranked hits AND their staleness verdicts
 * in one pass, so this prints exactly what an agent calling the product would
 * be handed — no second query that could disagree with the first. Before M15 it
 * also printed a "Code" section from the structural graph, and the by-meaning
 * listing had to be a separate query because the pipeline's own context was
 * recency-sorted; `PipelineResult.byMeaning` carries the ranking now.
 *
 * The spike measured the node-gated path at MRR 0.13 against 0.75 for this;
 * M11 re-measured the shipped package path at 0.85 lexical-only / 0.90 with
 * the stub embedder, and M15's gate re-confirmed both numbers with the
 * structural graph present and absent (see BENCHMARKS.md).
 */
async function ask(question) {
  if (!question) throw new Error('usage: self-memory.mjs ask "your question"');

  const { byMeaning: knowledge, staleness: verdicts } = await pipelineMod.runPipeline(question, {
    embedder: await embedderOrNone(),
    byMeaning: { limit: ASK_LIMIT, minVectorScore: MIN_VECTOR_SCORE },
    maxExperiences: ASK_LIMIT,
    contextOptions: { maxExperiences: ASK_LIMIT },
    // spec.md §24.2.3 / M12: one git lookup, so a memory the history has
    // overtaken arrives tagged rather than silently trusted.
    stalenessRepoDir: REPO,
  });
  const verdictById = new Map(verdicts.map((v) => [v.experience.id, v]));

  // A warning that fires on nearly every row is not a warning. Capture anchors a
  // memory to every file its commit touched, so on a live repo the flag rate
  // runs 90%+ (210/215 on the replay corpus). Above half, print the base rate
  // once instead of a banner per hit; `suspects` still lists them.
  const { rows: [rate] } = await getDb().query(
    "SELECT sum(suspect) AS flagged, count(*) AS total FROM experiences WHERE superseded_by IS NULL"
  );
  const banners = (rate?.flagged ?? 0) * 2 <= (rate?.total ?? 0);

  console.log(`## Why / prior knowledge (${knowledge.length})\n`);
  if (knowledge.length === 0) {
    console.log("(nothing recorded for this — run `sync`, or the question may be new ground)");
  } else if (!banners) {
    console.log(
      `_${rate.flagged}/${rate.total} memories are flagged possibly-stale (a newer commit touched an anchored file) — too many to flag individually; check any memory against the current code before trusting it._\n`
    );
  }
  // Total body budget across hits, top hit first. The 2026-08-27 A/B measured a
  // 14-line cut losing the deciding sentence; the 2026-08-28 replay measured the
  // uncut version injecting a median 9 KB (max 36 KB) that answers cited 4/19
  // times. A budget shared in rank order keeps the top hit nearly whole.
  let budget = BODY_BUDGET_CHARS;
  for (const hit of knowledge) {
    const k = hit.experience;
    const verdict = verdictById.get(k.id);
    console.log(
      `### ${k.task}\n_${k.action ?? "unknown source"} · ${new Date(k.timestamp)
        .toISOString()
        .slice(0, 10)} · ${hit.reason} (${hit.legs.join("+")}), score ${hit.score.toFixed(4)}_\n`
    );
    if (banners && verdict?.possiblyStale) {
      // ROADMAP.md M13 (c): a flag with no next step is what made M12's 24-of-27
      // flag rate useless. Print the id and the skill that repairs it, so the
      // dogfooding loop exercises read-repair instead of just noticing rot.
      console.log(`> **${core.POSSIBLY_STALE_FLAG}** (${verdict.reason})`);
      console.log(`> ${core.REFINE_MEMORY_HINT} — \`/refine-memory ${k.id}\`\n`);
    }
    // spec.md §26: the digest is what was retrieved, so the digest is what is
    // shown. The raw body stays one `show` away.
    const text = k.digest ?? k.observation;
    const body = text.length > budget
      ? `${text.slice(0, Math.max(budget, 0))}\n_(… ${text.length - budget} more chars — \`claude-notebook show ${k.id}\`)_`
      : text;
    budget = Math.max(budget - text.length, 200);
    console.log(`${body}\n`);
  }
  await closeDb();
}

/** Appends one experience — how a session, or the quality hook, writes back. */
async function record(json) {
  const input = JSON.parse(json);
  const files = input.files ?? [];
  // spec.md §24.2.2 / §24.4: memories bind to the changed files as text
  // anchors, and since M15 that is the only binding there is. It was always the
  // load-bearing one — a node id names a symbol, so §24.2.3's staleness pass
  // had nothing to ask git about it, and the quality gate writes here on every
  // task, which would have made the fastest-rotting memories in the system the
  // ones staleness could never reach.
  const anchors = files.map((f) => ({ path: path.relative(REPO, path.resolve(REPO, f)) }));
  const saved = await episodic.recordExperience({
    task: input.task,
    observation: input.observation,
    action: input.action,
    result: input.result,
    lessons: input.lessons ?? [input.observation],
    relatedNodes: anchors.map((a) => a.path),
    anchors,
    confidence: input.confidence ?? 0.7,
  });
  console.log(JSON.stringify({ id: saved.id, anchors: saved.anchors?.length ?? 0 }));
  await closeDb();
}

/**
 * Persists a distilled scout report (spec.md §24.2.1's second capture source
 * class). Takes a path to a JSON file rather than inline JSON: a real report is
 * multi-paragraph prose and does not survive a shell argument intact.
 *
 * Expected shape (see packages/capture's `ScoutReportInput`):
 *   { "task": "...", "understanding": "...", "anchors": ["packages/x/src/y.ts"] }
 *
 * The §24.2.1 guardrail applies — a report that is really a file listing is
 * rejected rather than written.
 */
/**
 * One anchor, repo-relative. Accepts both wire forms an agent actually writes:
 * a `"path#symbol"` string (parsed, so `#` is not swallowed by `path.resolve`)
 * and an `{ path, symbol? }` object — the shape `.claude/scout-report.json` is
 * documented with. Passing the object straight to `path.resolve` threw
 * ERR_INVALID_ARG_TYPE and lost the report.
 */
function relAnchor(a) {
  const parsed = typeof a === "string" ? core.parseAnchor(a) : a;
  return { ...parsed, path: path.relative(REPO, path.resolve(REPO, parsed.path)) };
}

async function scout(file) {
  if (!file) throw new Error("usage: self-memory.mjs scout <path-to-report.json>");
  const input = JSON.parse(await readFile(path.resolve(REPO, file), "utf-8"));
  const saved = await capture.recordScoutReport({
    ...input,
    anchors: (input.anchors ?? []).map(relAnchor),
    embedder: await embedderOrNone(),
  });
  console.log(JSON.stringify({ id: saved.id, anchors: saved.relatedNodes.length }));
  await closeDb();
}

/**
 * Runs spec.md §24.2.3's sync-time staleness pass on its own, without
 * re-mining. Useful after a merge: `sync` does this too, but this is the cheap
 * half when no new commits are worth capturing as knowledge.
 */
async function stale() {
  const result = await staleness.markSuspectFromHistory({ repoDir: REPO, limit: 500 });
  const { rows } = await getDb().query(
    `SELECT id, task, suspect_reason FROM experiences
      WHERE suspect AND superseded_by IS NULL
      ORDER BY "timestamp" DESC LIMIT 10`
  );
  console.log(
    JSON.stringify(
      {
        changedPaths: result.changedPaths,
        candidates: result.candidates,
        markedSuspect: result.marked,
        examples: rows.map((r) => `${r.task.slice(0, 60)} :: ${r.suspect_reason}`),
      },
      null,
      2
    )
  );
  await closeDb();
}

/**
 * The read-repair worklist: which memories history has overtaken, with enough
 * context to go and check one (spec.md §24.2.4 / M13). This is what
 * `.claude/skills/refine-memory` reads in step 1.
 *
 * Ordered oldest-first, not newest-first, deliberately: the oldest suspect
 * memory has had the most history pile up on top of it and is the most likely
 * to actually be wrong, which is the opposite of what a "latest first" listing
 * would surface.
 */
async function suspects(limitArg) {
  const limit = Number(limitArg) > 0 ? Number(limitArg) : 10;
  const { rows } = await getDb().query(
    `SELECT id, task, action, anchors, suspect_reason, "timestamp", verified_at
       FROM experiences
      WHERE suspect AND superseded_by IS NULL
      ORDER BY "timestamp" ASC
      LIMIT $1`,
    [limit]
  );
  console.log(
    JSON.stringify(
      rows.map((r) => ({
        id: r.id,
        task: r.task,
        source: r.action,
        // TEXT ISO-8601 UTC columns since the SQLite port (spec.md §25.5), so
        // the date is a string slice rather than a Date round-trip, and
        // `anchors` is JSON text rather than a driver-parsed array.
        written: r.timestamp.slice(0, 10),
        verifiedAt: r.verified_at?.slice(0, 10),
        anchors: JSON.parse(r.anchors ?? "[]").map((a) => (a.symbol ? `${a.path}#${a.symbol}` : a.path)),
        why: r.suspect_reason,
      })),
      null,
      2
    )
  );
  await closeDb();
}

/** One memory in full, plus its supersede chain — step 2 of the refine skill. */
async function show(id) {
  if (!id) throw new Error("usage: self-memory.mjs show <experience-id>");
  const chain = await episodic.memoryHistory(id);
  const target = chain.find((e) => e.id === id);
  if (!target) {
    console.log(JSON.stringify({ error: `no such memory: ${id}` }));
    await closeDb();
    return;
  }
  console.log(
    JSON.stringify(
      {
        id: target.id,
        task: target.task,
        source: target.action,
        timestamp: target.timestamp,
        verifiedAt: target.verifiedAt,
        suspect: target.suspect,
        suspectReason: target.suspectReason,
        supersededBy: target.supersededBy,
        anchors: target.anchors,
        confidence: target.confidence,
        chain: chain.map((e) => e.id),
        // Both, per spec.md §26: the digest is what retrieval matched on, the
        // observation is the immutable source it was derived from, and a reader
        // checking whether the digest lost something needs to see the pair.
        digest: target.digest ?? null,
        observation: target.observation,
        lessons: target.lessons,
      },
      null,
      2
    )
  );
  await closeDb();
}

/**
 * Read-repair outcome A: the memory was checked against the code and is still
 * accurate. Clears M12's suspect mark and stamps the check instant, so the
 * read-time staleness test stops re-deriving the same verdict from the same
 * commit (see `stalenessAsOf`).
 */
async function verify(id, asOf) {
  if (!id) throw new Error("usage: self-memory.mjs verify <experience-id> [read-instant-iso]");
  // The instant the code was READ, not the instant this write lands. A refine
  // run reads the anchors, thinks, and writes minutes later; stamping the write
  // time would silently claim to have verified against commits that landed in
  // between, and those commits could then never re-raise the flag. The skill
  // captures `date -u +%FT%TZ` before it starts reading and passes it here.
  // Defaults to now, which is only correct for an instantaneous check.
  const verifiedAt = asOf ? new Date(asOf).toISOString() : new Date().toISOString();
  if (Number.isNaN(Date.parse(verifiedAt))) throw new Error(`unparseable instant: ${asOf}`);
  const ok = await episodic.recordVerification(id, verifiedAt);
  console.log(JSON.stringify({ id, verified: ok, verifiedAt, stampedFrom: asOf ? "read-instant" : "now" }));
  await closeDb();
}

/**
 * Read-repair outcome B: the memory was wrong, and here is the correction.
 *
 * Takes a JSON file rather than inline JSON for the same reason `scout` does —
 * a real correction is multi-paragraph prose that does not survive a shell
 * argument intact.
 *
 *   { "supersedes": "<id>", "task": "...", "observation": "...",
 *     "anchors": ["packages/x/src/y.ts"], "lessons": ["..."], "confidence": 0.8 }
 *
 * `anchors` may be omitted to inherit the superseded memory's own — a
 * correction is about the same code by definition.
 *
 * The embedding is written straight after the memory, not left to the next
 * `sync`: the vector leg is one of three in by-meaning retrieval, and a
 * correction that only two legs can see is a correction that ranks below the
 * memory it replaced.
 */
async function supersede(file) {
  if (!file) throw new Error("usage: self-memory.mjs supersede <path-to-correction.json>");
  const input = JSON.parse(await readFile(path.resolve(REPO, file), "utf-8"));
  if (!input.supersedes) throw new Error("correction must name the memory it `supersedes`");

  if (!input.task) throw new Error(`correction for ${input.supersedes} needs a \`task\``);
  if (!input.observation) {
    throw new Error(`correction for ${input.supersedes} needs an \`observation\``);
  }

  // `parseAnchor`, not a bare path: an entry may be `path#symbol`, and
  // `path.resolve` would swallow the `#` into the path — silently making a
  // symbol-scoped correction impossible to express through this CLI even though
  // the Anchor type and the staleness matcher both support one.
  const anchors = input.anchors ? input.anchors.map(relAnchor) : undefined;
  const { experience, superseded } = await episodic.recordSupersedingExperience({
    supersedes: input.supersedes,
    task: input.task,
    observation: input.observation,
    action: input.action ?? `refine-memory: corrects ${input.supersedes}`,
    result: input.result,
    lessons: input.lessons ?? [input.observation],
    // Mirrored in text form, or inherited from the superseded memory when the
    // caller did not re-anchor — the two bindings move together (M13).
    relatedNodes: anchors ? anchors.map((a) => core.formatAnchor(a)) : undefined,
    anchors,
    confidence: input.confidence ?? 0.8,
  });

  // Same text shape capture embeds its mined memories with, so the vector leg
  // ranks a correction on the same footing as everything else in the corpus.
  // Skipped rather than fatal when the model is unavailable: the correction is
  // already written at this point, and the next `sync` backfills the embedding
  // — failing here would abort the command after a partial write.
  const supersedeEmbedder = await embedderOrNone();
  if (supersedeEmbedder) {
    await graphStore.upsertExperienceEmbedding(
      experience.id,
      await supersedeEmbedder.embed(capture.embeddedText(experience))
    );
  }

  console.log(
    JSON.stringify(
      {
        recorded: experience.id,
        supersedes: superseded.id,
        // What the CORRECTION ended up with, not what this call resolved —
        // both are inherited from the superseded memory when omitted, and
        // reporting the resolved count would print 0 for the common case.
        anchors: experience.anchors?.length ?? 0,
        boundTo: experience.relatedNodes.length,
        // True when BOTH bindings came from the superseded memory — which is
        // the same condition, since they are inherited together.
        inheritedBindings: anchors === undefined,
      },
      null,
      2
    )
  );
  await closeDb();
}

/** The whole supersede chain for one memory, oldest first — "what did we believe before". */
async function history(id) {
  if (!id) throw new Error("usage: self-memory.mjs history <experience-id>");
  const chain = await episodic.memoryHistory(id);
  console.log(
    JSON.stringify(
      chain.map((e) => ({
        id: e.id,
        timestamp: e.timestamp,
        supersededBy: e.supersededBy,
        task: e.task,
        observation: e.observation.split("\n").slice(0, 6).join("\n"),
      })),
      null,
      2
    )
  );
  await closeDb();
}

async function stats() {
  const db = getDb();
  // `count(*) FILTER (WHERE ...)` -> `sum(CASE WHEN ... THEN 1 ELSE 0 END)`
  // (spec.md §25.5), and every count is aliased: SQLite names a bare `count(*)`
  // column `count(*)`, so an unaliased one reads back as `undefined`.
  const [experiences, tiers, flags, latest] = await Promise.all([
    db.query("SELECT count(*) AS count FROM experiences"),
    db.query("SELECT tier, count(*) AS count FROM experiences GROUP BY tier"),
    db.query(
      // COALESCE because `sum()` over ZERO rows is NULL where the
      // `count(*) FILTER (WHERE ...)` it replaces was 0 — on an empty memory
      // this printed `"suspect": null` (and `NaN` once `Number()` saw it).
      `SELECT coalesce(sum(CASE WHEN suspect AND superseded_by IS NULL THEN 1 ELSE 0 END), 0) AS suspect,
              coalesce(sum(CASE WHEN superseded_by IS NOT NULL THEN 1 ELSE 0 END), 0) AS superseded,
              coalesce(sum(CASE WHEN cold THEN 1 ELSE 0 END), 0) AS cold
         FROM experiences`
    ),
    db.query('SELECT task, action FROM experiences ORDER BY "timestamp" DESC LIMIT 5'),
  ]);
  console.log(
    JSON.stringify(
      {
        experiences: Number(experiences.rows[0].count),
        tiers: Object.fromEntries(tiers.rows.map((r) => [r.tier, Number(r.count)])),
        suspect: Number(flags.rows[0].suspect),
        superseded: Number(flags.rows[0].superseded),
        cold: Number(flags.rows[0].cold),
        newest: latest.rows.map((r) => `${r.action ?? "-"} ${r.task}`.slice(0, 90)),
      },
      null,
      2
    )
  );
  await closeDb();
}

const [cmd, ...rest] = process.argv.slice(2);
const commands = {
  sync,
  ask: () => ask(rest.join(" ")),
  record: () => record(rest.join(" ")),
  scout: () => scout(rest[0]),
  stale,
  suspects: () => suspects(rest[0]),
  show: () => show(rest[0]),
  verify: () => verify(rest[0], rest[1]),
  supersede: () => supersede(rest[0]),
  history: () => history(rest[0]),
  stats,
};
const run = commands[cmd];
if (!run) {
  console.error(
    "usage: claude-notebook <sync|ask|record|scout|stale|suspects|show|verify|supersede|history|stats>"
  );
  process.exit(1);
}
// Every command migrates, not just the writing ones. `getDb()` creates the file
// on open, so a read command against a database that does not exist yet used to
// fail with `no such table: experiences` — which reads as "the memory is broken"
// rather than "run sync first", and is reachable simply by following README's
// order (`ask` before `sync`). `runMigrations` is idempotent and takes ~1 ms on
// an up-to-date database.
runMigrations()
  .then(run)
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
