/**
 * Layer 5: does knowledge actually accumulate across sessions?
 *
 * This is the claim the original benchmark report explicitly could not test —
 * it seeded invented experiences and said so. Here the experience written to
 * the graph is derived from what a real agent session actually did.
 *
 * Per chain:
 *
 *   1. context for task A                        (runPipeline)
 *   2. context for task B *before* anything is   (runPipeline) -- structural only,
 *      recorded                                                   captured now because
 *                                                                 step 4 mutates the graph
 *   3. session 1: agent fixes task A with (1)
 *   4. record a real Experience from session 1's own output, attached to the
 *      file nodes the agent actually edited
 *   5. context for task B *after* the recording  (runPipeline) -- may now carry episodic
 *   6. session 2: three conditions on task B —
 *        bare              no context
 *        memory            context from (2), structural only
 *        memory+episodic   context from (5), structural + what session 1 learned
 *
 * The interesting number is not just turns-to-fix: it is whether the recorded
 * experience surfaces in (5) at all. If traversal for task B never reaches the
 * nodes session 1 touched, episodic memory is unreachable by construction —
 * and that is a finding about the design, not a failed run.
 */
import fs from "node:fs";
import path from "node:path";
import { renderContext } from "@cognitive-memory/context";
import { recordExperience } from "@cognitive-memory/episodic";
import { closePool, getPool } from "@cognitive-memory/graph-store";
import { runPipeline } from "@cognitive-memory/pipeline";
import { createFakeEmbedder } from "@cognitive-memory/retrieval";
import { createPostgresGraphProvider } from "@cognitive-memory/traversal";
import { activeTarget, resultsDir, targetDir } from "./config.js";
import {
  MODEL,
  applySeed,
  assertSeedIsLive,
  bugPrompt,
  cleanup,
  detectAndRestoreEscape,
  filesTouched,
  makeWorkingCopy,
  rewriteRoot,
  runAgent,
  verify,
} from "./patchRunner.js";
import { CHAINS, type PatchTask } from "./patchTasks.js";
import { createHeuristicReasoner } from "./reasoners.js";

type Condition = "bare" | "memory" | "memory+episodic";

interface SessionRun {
  chainId: string;
  session: 1 | 2;
  taskId: string;
  condition: Condition;
  fixed: boolean;
  touchedExpectedFile: boolean;
  filesTouched: string[];
  escapedWorkingCopy: boolean;
  durationMs: number;
  numTurns: number;
  costUsd: number | null;
  contextChars: number;
  experiencesInContext: number;
  answer: string;
}

const embedder = createFakeEmbedder();
const graph = createPostgresGraphProvider();
const reasoner = createHeuristicReasoner();

async function contextFor(task: string, repoId: string) {
  const { context } = await runPipeline(task, {
    repoId,
    embedder,
    graph,
    reasoner,
    contextOptions: { maxSourceFiles: 10 },
  });
  return { rendered: renderContext(context), experiences: context.experiences.length };
}

/** File-node ids in the graph whose path ends with one of `fileNames`. */
async function nodeIdsForFiles(repoId: string, fileNames: string[]): Promise<string[]> {
  if (fileNames.length === 0) return [];
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT id FROM nodes
      WHERE repo_id = $1 AND type = 'file'
        AND (${fileNames.map((_, i) => `path LIKE $${i + 2}`).join(" OR ")})`,
    [repoId, ...fileNames.map((f) => `%/${f}`)]
  );
  return rows.map((r) => r.id);
}

async function runOne(
  source: string,
  task: PatchTask,
  context: string | undefined,
  label: string
): Promise<{ run: Omit<SessionRun, "chainId" | "session" | "condition">; touched: string[] }> {
  const seededRef = makeWorkingCopy(source, `${label}-ref`);
  applySeed(seededRef, task);
  await assertSeedIsLive(seededRef, task);

  const dir = makeWorkingCopy(source, label);
  applySeed(dir, task);
  // Context carries absolute paths from the ingested clone; point them at
  // this copy so the agent cannot edit the source repo instead.
  const res = await runAgent(
    bugPrompt(task.symptom, context ? rewriteRoot(context, source, dir) : undefined),
    dir
  );
  const verifyError = await verify(dir, task);
  const touched = filesTouched(seededRef, dir);
  const escaped = await detectAndRestoreEscape(source);
  cleanup(dir);
  cleanup(seededRef);

  return {
    touched,
    run: {
      taskId: task.id,
      fixed: verifyError === null,
      touchedExpectedFile: task.expectedFiles.some((f) => touched.includes(f)),
      filesTouched: touched,
      escapedWorkingCopy: escaped,
      durationMs: res.duration_ms ?? res.wallMs,
      numTurns: res.num_turns ?? -1,
      costUsd: res.total_cost_usd ?? null,
      contextChars: context?.length ?? 0,
      experiencesInContext: 0,
      answer: res.result ?? "",
    },
  };
}

async function main(): Promise<void> {
  const target = activeTarget();
  const source = targetDir(target);
  const runs: SessionRun[] = [];
  const chainSummaries: Record<string, unknown>[] = [];

  for (const chain of CHAINS) {
    console.log(`\n=== chain ${chain.id}: ${chain.first.id} -> ${chain.second.id} ===`);

    const ctxA = await contextFor(chain.first.symptom, target.repoId);
    // Captured before anything is recorded: this is task B's context in a
    // world where session 1 never happened.
    const ctxBPre = await contextFor(chain.second.symptom, target.repoId);

    // --- session 1 -------------------------------------------------------
    const s1 = await runOne(source, chain.first, ctxA.rendered, `${chain.id}-s1`);
    runs.push({ ...s1.run, chainId: chain.id, session: 1, condition: "memory", experiencesInContext: ctxA.experiences });
    console.log(`session1: fixed=${s1.run.fixed} turns=${s1.run.numTurns} touched=[${s1.touched.join(",")}]`);

    // --- record what session 1 learned -----------------------------------
    // Derived from the run's own artifacts (the files it edited and the
    // explanation it gave), not hand-authored: this is what an agent calling
    // recordExperience at the end of its task would write.
    const relatedNodes = await nodeIdsForFiles(target.repoId, s1.touched);
    const lesson =
      `Fixing "${chain.first.symptom.slice(0, 80)}..." came down to ` +
      `${s1.touched.join(", ") || "(no file changed)"}. ` +
      `Agent's account: ${(s1.run.answer || "").replace(/\s+/g, " ").slice(0, 400)}`;
    const experience =
      relatedNodes.length > 0
        ? await recordExperience({
            task: chain.first.symptom,
            observation: lesson,
            lessons: [lesson],
            relatedNodes,
            confidence: 0.8,
          })
        : null;
    console.log(
      `recorded experience on ${relatedNodes.length} node(s)` +
        (experience ? ` (${experience.id})` : " — nothing to attach to, skipped")
    );

    // --- session 2 -------------------------------------------------------
    const ctxBPost = await contextFor(chain.second.symptom, target.repoId);
    const episodicReached = ctxBPost.experiences > ctxBPre.experiences;
    console.log(
      `task B context: experiences before=${ctxBPre.experiences} after=${ctxBPost.experiences} ` +
        `(session-1 lesson reachable: ${episodicReached})`
    );

    for (const condition of ["bare", "memory", "memory+episodic"] as const) {
      const context =
        condition === "bare"
          ? undefined
          : condition === "memory"
            ? ctxBPre.rendered
            : ctxBPost.rendered;
      const r = await runOne(source, chain.second, context, `${chain.id}-s2-${condition}`);
      runs.push({
        ...r.run,
        chainId: chain.id,
        session: 2,
        condition,
        experiencesInContext: condition === "memory+episodic" ? ctxBPost.experiences : condition === "memory" ? ctxBPre.experiences : 0,
      });
      console.log(
        `session2/${condition}: fixed=${r.run.fixed} turns=${r.run.numTurns} ` +
          `touched=[${r.touched.join(",")}] ${Math.round(r.run.durationMs / 1000)}s`
      );
    }

    chainSummaries.push({
      chainId: chain.id,
      relation: chain.relation,
      firstTask: chain.first.id,
      secondTask: chain.second.id,
      session1Touched: s1.touched,
      experienceRecordedOnNodes: relatedNodes.length,
      experienceId: experience?.id ?? null,
      taskBExperiencesBefore: ctxBPre.experiences,
      taskBExperiencesAfter: ctxBPost.experiences,
      episodicReachedTaskB: episodicReached,
      taskBContextCharsBefore: ctxBPre.rendered.length,
      taskBContextCharsAfter: ctxBPost.rendered.length,
    });
  }

  const session2 = runs.filter((r) => r.session === 2);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  const summarize = (condition: Condition) => {
    const subset = session2.filter((r) => r.condition === condition);
    return {
      runs: subset.length,
      fixRate: mean(subset.map((r) => (r.fixed ? 1 : 0))),
      rightFileRate: mean(subset.map((r) => (r.touchedExpectedFile ? 1 : 0))),
      meanTurns: mean(subset.map((r) => r.numTurns)),
      meanDurationMs: mean(subset.map((r) => r.durationMs)),
      totalCostUsd: subset.reduce((a, r) => a + (r.costUsd ?? 0), 0),
    };
  };

  const output = {
    target: target.key,
    model: MODEL,
    chains: chainSummaries,
    session2: {
      bare: summarize("bare"),
      memory: summarize("memory"),
      "memory+episodic": summarize("memory+episodic"),
    },
    runs,
  };
  fs.mkdirSync(resultsDir(), { recursive: true });
  fs.writeFileSync(path.join(resultsDir(), "session-chain.json"), JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ chains: chainSummaries, session2: output.session2 }, null, 2));
  await closePool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
