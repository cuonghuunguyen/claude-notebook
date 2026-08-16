/**
 * Writes the mined history into the graph as real `Experience` records bound
 * to the file nodes each commit touched — the missing half of spec.md §8.
 *
 * Uses the shipped `recordExperience` unchanged, so what lands in Postgres is
 * exactly what the system's own episodic layer stores. Only the *source* is
 * new.
 */
import { recordExperience } from "@cognitive-memory/episodic";
import { closePool, getPool } from "@cognitive-memory/graph-store";
import { lessonFrom, mineCommits } from "./corpus.js";
import { REPO_ID, repoDir, pathScope } from "./config.js";

/** Maps repo-relative commit paths onto the absolute paths stored at ingest. */
async function fileNodeIndex(): Promise<Map<string, string>> {
  const { rows } = await getPool().query<{ id: string; path: string }>(
    "SELECT id, path FROM nodes WHERE repo_id = $1 AND type = 'file' AND path IS NOT NULL",
    [REPO_ID]
  );
  const bySuffix = new Map<string, string>();
  for (const row of rows) bySuffix.set(row.path, row.id);
  return bySuffix;
}

function resolve(index: Map<string, string>, repoRelative: string): string | undefined {
  for (const [absolute, id] of index) {
    if (absolute.endsWith(`/${repoRelative}`)) return id;
  }
  return undefined;
}

async function main(): Promise<void> {
  const commits = await mineCommits(repoDir(), pathScope());
  const index = await fileNodeIndex();

  let recorded = 0;
  let unbound = 0;
  const perFile = new Map<string, number>();

  // Oldest first, so the append-only log reads in the order things happened.
  for (const commit of [...commits].reverse()) {
    const nodeIds = commit.files
      .map((f) => resolve(index, f))
      .filter((id): id is string => Boolean(id));
    if (nodeIds.length === 0) {
      unbound += 1;
      continue;
    }
    const lesson = lessonFrom(commit);
    await recordExperience({
      task: commit.subject,
      observation: lesson,
      // `action` is the closest field spec.md §8 gives for "what was done";
      // the sha is what makes the record checkable against the repo.
      action: `commit ${commit.shortSha}`,
      lessons: [lesson],
      relatedNodes: nodeIds,
      // Evidence hierarchy (spec.md §4): git history sits below code and
      // tests, above bare LLM inference.
      confidence: 0.7,
      timestamp: commit.date || undefined,
    });
    recorded += 1;
    for (const f of commit.files) perFile.set(f, (perFile.get(f) ?? 0) + 1);
  }

  const top = [...perFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log(
    JSON.stringify(
      {
        commitsMined: commits.length,
        experiencesRecorded: recorded,
        skippedUnbound: unbound,
        filesCovered: perFile.size,
        busiest: top.map(([f, n]) => `${n}× ${f.split("/").slice(-2).join("/")}`),
      },
      null,
      2
    )
  );
  await closePool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
