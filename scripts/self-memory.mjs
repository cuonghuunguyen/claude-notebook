#!/usr/bin/env node
/**
 * Dogfooding: point this memory system at this repository.
 *
 * Two things go into the graph, because the benchmarks showed one without the
 * other is what made the memory useless:
 *
 *   structure — every .ts under packages/ and eval/ (ts-morph -> nodes/edges)
 *   knowledge — this repo's own commits that explain themselves, recorded as
 *               Experiences bound to the files they touched
 *
 * `WHY_MEMORY_SPIKE.md` measured the second half as the one that pays: on
 * questions about *why* the code is the way it is, memory cut an agent from
 * 7.7 turns to 1.4 against a baseline that had full git access. Structure
 * alone loses to grep.
 *
 * Usage:
 *   node scripts/self-memory.mjs sync             # ingest structure + history
 *   node scripts/self-memory.mjs ask "why ...?"   # query it
 *   node scripts/self-memory.mjs record <json>    # append one experience
 *   node scripts/self-memory.mjs scout <file>     # persist a distilled scout report
 *   node scripts/self-memory.mjs stale            # re-flag what history overtook
 *   node scripts/self-memory.mjs suspects [n]     # what read-repair should look at
 *   node scripts/self-memory.mjs show <id>        # one memory, in full, with its chain
 *   node scripts/self-memory.mjs verify <id> [at]  # M13: checked, still accurate
 *   node scripts/self-memory.mjs supersede <file> # M13: checked, here is the correction
 *   node scripts/self-memory.mjs history <id>     # the whole supersede chain
 *   node scripts/self-memory.mjs stats
 *
 * As of M11 the capture and by-meaning retrieval this script used to hand-roll
 * live in `packages/capture` and `packages/episodic`. What is left here is the
 * wiring: which repo, which globs, and how the output is printed.
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ID = "claude-notebook";

const require = createRequire(path.join(ROOT, "packages/structural/package.json"));
const { Project } = require("ts-morph");

const [{ extractProject, persistExtraction }, graphStore, retrieval, traversal, pipelineMod, episodic, contextMod, capture, staleness, core] =
  await Promise.all([
    import(path.join(ROOT, "packages/structural/dist/index.js")),
    import(path.join(ROOT, "packages/graph-store/dist/index.js")),
    import(path.join(ROOT, "packages/retrieval/dist/index.js")),
    import(path.join(ROOT, "packages/traversal/dist/index.js")),
    import(path.join(ROOT, "packages/pipeline/dist/index.js")),
    import(path.join(ROOT, "packages/episodic/dist/index.js")),
    import(path.join(ROOT, "packages/context/dist/index.js")),
    import(path.join(ROOT, "packages/capture/dist/index.js")),
    import(path.join(ROOT, "packages/staleness/dist/index.js")),
    import(path.join(ROOT, "packages/core/dist/index.js")),
  ]);

const { closePool, getPool, runMigrations } = graphStore;

/** Source scope: the library and its harnesses, excluding tests and build output. */
const GLOBS = [
  `${ROOT}/packages/*/src/**/*.ts`,
  `${ROOT}/eval/*/src/**/*.ts`,
  `!${ROOT}/**/*.test.ts`,
  `!${ROOT}/**/dist/**`,
];

async function sync() {
  await runMigrations();
  const t0 = Date.now();

  const project = new Project({ compilerOptions: { rootDir: ROOT } });
  project.addSourceFilesAtPaths(GLOBS);
  const extraction = extractProject(project, REPO_ID);
  await persistExtraction(extraction, REPO_ID);
  await retrieval.indexNodeEmbeddings(extraction.nodes, retrieval.createFakeEmbedder());
  const structureMs = Date.now() - t0;

  // Knowledge half: our own history, through the shipped capture package.
  // Idempotent by contract (spec.md §24.2.1) — re-running after a merge only
  // records commits that are actually new.
  const t1 = Date.now();
  const { rows } = await getPool().query(
    "SELECT id, path FROM nodes WHERE repo_id = $1 AND type = 'file' AND path IS NOT NULL",
    [REPO_ID]
  );
  const idByPath = new Map(rows.map((r) => [r.path, r.id]));
  // The structural graph is still alive until M15, so keep new memories bound
  // to it as well as to their text anchors — that is what `resolveNodeIds` is
  // for. Text anchors are written unconditionally by the package.
  const resolveNodeIds = (paths) =>
    paths.map((f) => idByPath.get(path.join(ROOT, f))).filter(Boolean);

  const embedder = retrieval.createFakeEmbedder();
  // Whole repo, not just `packages/`: the commits that recorded this project's
  // biggest decisions (the spec.md §24 pivot, for instance) touch spec.md and
  // ROADMAP.md at the root, and a subtree-scoped mine cannot see them — which
  // made the most valuable "why" here the part the memory did not have.
  const result = await capture.captureGitHistory({
    repoDir: ROOT,
    pathScope: "",
    limit: 500,
    resolveNodeIds,
    embedder,
  });
  const mined = result.mined;
  const added = result.recorded;

  // spec.md §24.2.3 / M12: now that history has been mined, flag the memories
  // that history has since overtaken. Runs after capture, not before: a commit
  // mined in this same pass must not flag the memory it just created (capture
  // stamps the commit's own date, and the test is strictly-newer).
  const suspect = await staleness.markSuspectFromHistory({ repoDir: ROOT, limit: 500 });

  console.log(
    JSON.stringify(
      {
        repoId: REPO_ID,
        files: project.getSourceFiles().length,
        nodes: extraction.nodes.length,
        edges: extraction.edges.length,
        structureMs,
        explanatoryCommits: mined,
        experiencesAdded: added,
        knowledgeMs: Date.now() - t1,
        indexedFiles: idByPath.size,
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
  await closePool();
}

/**
 * Retrieve knowledge by its own content, through the shipped by-meaning API.
 * The spike measured the node-gated path at MRR 0.13 (it returns whatever is
 * newest on the traversed files) against 0.75 for this; M11 re-measured the
 * shipped package path at 0.85 lexical-only / 0.90 with the stub embedder (see
 * BENCHMARKS.md).
 */
async function askKnowledge(question, limit = 4) {
  return episodic.queryByMeaning(question, { limit, embedder: retrieval.createFakeEmbedder() });
}

async function ask(question) {
  if (!question) throw new Error('usage: self-memory.mjs ask "your question"');

  const { context } = await pipelineMod.runPipeline(question, {
    repoId: REPO_ID,
    embedder: retrieval.createFakeEmbedder(),
    graph: traversal.createPostgresGraphProvider(),
    reasoner: {
      async decide(ctx) {
        return {
          decisions: ctx.candidates.map((c) => ({
            edgeId: c.edgeId,
            action: c.score >= 0.15 ? "expand" : "skip",
          })),
          stop: false,
        };
      },
    },
    contextOptions: { maxSourceFiles: 8 },
    // spec.md §24.2.3 / M12: one git lookup, so a memory the history has
    // overtaken arrives tagged rather than silently trusted.
    stalenessRepoDir: ROOT,
  });

  const knowledge = await askKnowledge(question);
  // The by-meaning listing below is a second query, so it does not inherit the
  // pipeline's verdicts — re-flag it against the same history so what is
  // printed matches what the context says.
  const knowledgeVerdicts = await staleness.flagPossiblyStale(
    knowledge.map((h) => h.experience),
    { repoDir: ROOT }
  );

  console.log(`## Code (${context.sourceFiles.length} files)\n`);
  for (const f of context.sourceFiles) console.log(`- ${path.relative(ROOT, f.path)}`);

  console.log(`\n## Why / prior knowledge (${knowledge.length})\n`);
  if (knowledge.length === 0) {
    console.log("(nothing recorded for this — run `sync`, or the question may be new ground)");
  }
  for (const [i, hit] of knowledge.entries()) {
    const k = hit.experience;
    const verdict = knowledgeVerdicts[i];
    console.log(
      `### ${k.task}\n_${k.action ?? "unknown source"} · ${new Date(k.timestamp)
        .toISOString()
        .slice(0, 10)} · ${hit.reason} (${hit.legs.join("+")}), score ${hit.score.toFixed(4)}_\n`
    );
    if (verdict?.possiblyStale) {
      // ROADMAP.md M13 (c): a flag with no next step is what made M12's 24-of-27
      // flag rate useless. Print the id and the skill that repairs it, so the
      // dogfooding loop exercises read-repair instead of just noticing rot.
      console.log(`> **${core.POSSIBLY_STALE_FLAG}** (${verdict.reason})`);
      console.log(`> ${core.REFINE_MEMORY_HINT} — \`/refine-memory ${k.id}\`\n`);
    }
    console.log(`${k.observation.split("\n").slice(0, 14).join("\n")}\n`);
  }
  await closePool();
}

/** Appends one experience — how a session, or the quality hook, writes back. */
async function record(json) {
  const input = JSON.parse(json);
  const files = input.files ?? [];
  const { rows } = await getPool().query(
    "SELECT id, path FROM nodes WHERE repo_id = $1 AND type = 'file' AND path = ANY($2::text[])",
    [REPO_ID, files.map((f) => path.resolve(ROOT, f))]
  );
  const saved = await episodic.recordExperience({
    task: input.task,
    observation: input.observation,
    action: input.action,
    result: input.result,
    lessons: input.lessons ?? [input.observation],
    relatedNodes: rows.map((r) => r.id),
    // spec.md §24.2.2 / M12: also bind to the changed files as text anchors.
    // Node ids alone would leave these memories permanently unfalsifiable —
    // a node id names a symbol, so §24.2.3's staleness pass has nothing to ask
    // git about. The quality gate writes here on every task, so without this
    // the fastest-rotting memories in the system would be the ones staleness
    // could never reach.
    anchors: files.map((f) => ({ path: path.relative(ROOT, path.resolve(ROOT, f)) })),
    confidence: input.confidence ?? 0.7,
  });
  console.log(
    JSON.stringify({ id: saved.id, boundTo: rows.length, anchors: saved.anchors?.length ?? 0 })
  );
  await closePool();
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
async function scout(file) {
  if (!file) throw new Error("usage: self-memory.mjs scout <path-to-report.json>");
  const input = JSON.parse(await readFile(path.resolve(ROOT, file), "utf-8"));
  const saved = await capture.recordScoutReport({
    ...input,
    anchors: (input.anchors ?? []).map((a) => path.relative(ROOT, path.resolve(ROOT, a))),
    embedder: retrieval.createFakeEmbedder(),
  });
  console.log(JSON.stringify({ id: saved.id, anchors: saved.relatedNodes.length }));
  await closePool();
}

/**
 * Runs spec.md §24.2.3's sync-time staleness pass on its own, without
 * re-mining. Useful after a merge: `sync` does this too, but this is the cheap
 * half when no new commits are worth capturing as knowledge.
 */
async function stale() {
  await runMigrations();
  const result = await staleness.markSuspectFromHistory({ repoDir: ROOT, limit: 500 });
  const { rows } = await getPool().query(
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
  await closePool();
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
  const { rows } = await getPool().query(
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
        written: r.timestamp.toISOString().slice(0, 10),
        verifiedAt: r.verified_at?.toISOString().slice(0, 10),
        anchors: (r.anchors ?? []).map((a) => (a.symbol ? `${a.path}#${a.symbol}` : a.path)),
        why: r.suspect_reason,
      })),
      null,
      2
    )
  );
  await closePool();
}

/** One memory in full, plus its supersede chain — step 2 of the refine skill. */
async function show(id) {
  if (!id) throw new Error("usage: self-memory.mjs show <experience-id>");
  const chain = await episodic.memoryHistory(id);
  const target = chain.find((e) => e.id === id);
  if (!target) {
    console.log(JSON.stringify({ error: `no such memory: ${id}` }));
    await closePool();
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
        observation: target.observation,
        lessons: target.lessons,
      },
      null,
      2
    )
  );
  await closePool();
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
  await closePool();
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
  const input = JSON.parse(await readFile(path.resolve(ROOT, file), "utf-8"));
  if (!input.supersedes) throw new Error("correction must name the memory it `supersedes`");

  if (!input.task) throw new Error(`correction for ${input.supersedes} needs a \`task\``);
  if (!input.observation) {
    throw new Error(`correction for ${input.supersedes} needs an \`observation\``);
  }

  // `parseAnchor`, not a bare path: an entry may be `path#symbol`, and
  // `path.resolve` would swallow the `#` into the path — silently making a
  // symbol-scoped correction impossible to express through this CLI even though
  // the Anchor type and the staleness matcher both support one.
  const anchors = input.anchors
    ? input.anchors.map((a) => {
        const parsed = core.parseAnchor(a);
        return { ...parsed, path: path.relative(ROOT, path.resolve(ROOT, parsed.path)) };
      })
    : undefined;
  // Only looked up when the caller re-anchored. When they did NOT, the node
  // bindings are inherited from the superseded memory (which is right — same
  // code); when they DID, the resolved set is passed even if it is empty, so a
  // correction cannot end up silently bound to the old memory's symbols after
  // being explicitly pointed somewhere else.
  const { rows } = anchors
    ? await getPool().query(
        "SELECT id FROM nodes WHERE repo_id = $1 AND type = 'file' AND path = ANY($2::text[])",
        [REPO_ID, anchors.map((a) => path.resolve(ROOT, a.path))]
      )
    : { rows: [] };

  const { experience, superseded } = await episodic.recordSupersedingExperience({
    supersedes: input.supersedes,
    task: input.task,
    observation: input.observation,
    action: input.action ?? `refine-memory: corrects ${input.supersedes}`,
    result: input.result,
    lessons: input.lessons ?? [input.observation],
    relatedNodes: anchors ? rows.map((r) => r.id) : undefined,
    anchors,
    confidence: input.confidence ?? 0.8,
  });

  // Same text shape capture embeds its mined memories with, so the vector leg
  // ranks a correction on the same footing as everything else in the corpus.
  await graphStore.upsertExperienceEmbedding(
    experience.id,
    await retrieval.createFakeEmbedder().embed(capture.embeddedText(experience))
  );

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
  await closePool();
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
  await closePool();
}

async function stats() {
  const pool = getPool();
  const [nodes, edges, experiences, latest] = await Promise.all([
    pool.query("SELECT type, count(*) FROM nodes WHERE repo_id = $1 GROUP BY type", [REPO_ID]),
    pool.query("SELECT relation, count(*) FROM edges WHERE repo_id = $1 GROUP BY relation", [REPO_ID]),
    pool.query("SELECT count(*) FROM experiences"),
    pool.query('SELECT task, action FROM experiences ORDER BY "timestamp" DESC LIMIT 5'),
  ]);
  console.log(
    JSON.stringify(
      {
        nodes: Object.fromEntries(nodes.rows.map((r) => [r.type, Number(r.count)])),
        edges: Object.fromEntries(edges.rows.map((r) => [r.relation, Number(r.count)])),
        experiences: Number(experiences.rows[0].count),
        newest: latest.rows.map((r) => `${r.action ?? "-"} ${r.task}`.slice(0, 90)),
      },
      null,
      2
    )
  );
  await closePool();
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
    "usage: self-memory.mjs <sync|ask|record|scout|stale|suspects|show|verify|supersede|history|stats>"
  );
  process.exit(1);
}
run().catch((err) => {
  console.error(err);
  process.exit(1);
});
