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
 *   node scripts/self-memory.mjs sync            # ingest structure + history
 *   node scripts/self-memory.mjs ask "why ...?"  # query it
 *   node scripts/self-memory.mjs record <json>   # append one experience
 *   node scripts/self-memory.mjs stats
 */
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ID = "claude-notebook";

const require = createRequire(path.join(ROOT, "packages/structural/package.json"));
const { Project } = require("ts-morph");

const [{ extractProject, persistExtraction }, graphStore, retrieval, traversal, pipelineMod, episodic, contextMod, corpus] =
  await Promise.all([
    import(path.join(ROOT, "packages/structural/dist/index.js")),
    import(path.join(ROOT, "packages/graph-store/dist/index.js")),
    import(path.join(ROOT, "packages/retrieval/dist/index.js")),
    import(path.join(ROOT, "packages/traversal/dist/index.js")),
    import(path.join(ROOT, "packages/pipeline/dist/index.js")),
    import(path.join(ROOT, "packages/episodic/dist/index.js")),
    import(path.join(ROOT, "packages/context/dist/index.js")),
    import(path.join(ROOT, "eval/why-spike/dist/corpus.js")),
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

  // Knowledge half: our own history. Only commits that explain themselves —
  // a bare "fix typo" carries nothing a future agent can't re-derive.
  const t1 = Date.now();
  const commits = await corpus.mineCommits(ROOT, "packages", 500);
  const evalCommits = await corpus.mineCommits(ROOT, "eval", 500);
  const all = [...commits, ...evalCommits];

  const { rows } = await getPool().query(
    "SELECT id, path FROM nodes WHERE repo_id = $1 AND type = 'file' AND path IS NOT NULL",
    [REPO_ID]
  );
  const known = new Set(rows.map((r) => r.path));
  const idByPath = new Map(rows.map((r) => [r.path, r.id]));

  // Skip commits already recorded, so `sync` is safe to re-run.
  const { rows: seen } = await getPool().query(
    "SELECT action FROM experiences WHERE action LIKE 'commit %'"
  );
  const recorded = new Set(seen.map((r) => r.action));

  let added = 0;
  for (const commit of [...all].reverse()) {
    if (recorded.has(`commit ${commit.shortSha}`)) continue;
    const nodeIds = commit.files
      .map((f) => idByPath.get(path.join(ROOT, f)))
      .filter(Boolean);
    if (nodeIds.length === 0) continue;
    const lesson = corpus.lessonFrom(commit);
    await episodic.recordExperience({
      task: commit.subject,
      observation: lesson,
      action: `commit ${commit.shortSha}`,
      lessons: [lesson],
      relatedNodes: nodeIds,
      confidence: 0.7,
      timestamp: commit.date || undefined,
    });
    added += 1;
  }

  console.log(
    JSON.stringify(
      {
        repoId: REPO_ID,
        files: project.getSourceFiles().length,
        nodes: extraction.nodes.length,
        edges: extraction.edges.length,
        structureMs,
        explanatoryCommits: all.length,
        experiencesAdded: added,
        knowledgeMs: Date.now() - t1,
        indexedFiles: known.size,
      },
      null,
      2
    )
  );
  await closePool();
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is",
  "are", "was", "were", "be", "it", "its", "that", "this", "why", "what",
  "how", "does", "do", "did", "when", "which", "we", "our", "i", "you",
  "not", "any", "ever", "still", "just", "also", "would", "could", "should",
]);

/**
 * Retrieve knowledge by its own content, not by exact node id. The spike
 * measured the shipped node-gated path at MRR 0.13 (it returns whatever is
 * newest on the traversed files) against 0.75 for this.
 */
async function askKnowledge(question, limit = 4) {
  const terms = [
    ...new Set(
      question
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .split(/[^a-zA-Z0-9_]+/)
        .map((t) => t.toLowerCase())
        .filter((t) => t.length > 2 && !STOPWORDS.has(t))
    ),
  ];
  if (terms.length === 0) return [];
  const { rows } = await getPool().query(
    `SELECT task, observation, action, "timestamp",
            ts_rank(to_tsvector('english', task || ' ' || observation),
                    to_tsquery('english', $1)) AS rank
       FROM experiences
      WHERE to_tsvector('english', task || ' ' || observation) @@ to_tsquery('english', $1)
      ORDER BY rank DESC, "timestamp" DESC LIMIT $2`,
    [terms.join(" | "), limit]
  );
  return rows;
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
  });

  const knowledge = await askKnowledge(question);

  console.log(`## Code (${context.sourceFiles.length} files)\n`);
  for (const f of context.sourceFiles) console.log(`- ${path.relative(ROOT, f.path)}`);

  console.log(`\n## Why / prior knowledge (${knowledge.length})\n`);
  if (knowledge.length === 0) {
    console.log("(nothing recorded for this — run `sync`, or the question may be new ground)");
  }
  for (const k of knowledge) {
    console.log(`### ${k.task}\n_${k.action} · ${new Date(k.timestamp).toISOString().slice(0, 10)}_\n`);
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
    confidence: input.confidence ?? 0.7,
  });
  console.log(JSON.stringify({ id: saved.id, boundTo: rows.length }));
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
const commands = { sync, ask: () => ask(rest.join(" ")), record: () => record(rest.join(" ")), stats };
const run = commands[cmd];
if (!run) {
  console.error("usage: self-memory.mjs <sync|ask|record|stats>");
  process.exit(1);
}
run().catch((err) => {
  console.error(err);
  process.exit(1);
});
