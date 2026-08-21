import type { Experience } from "@cognitive-memory/core";

/**
 * What `buildContext` projects from: the memories a retrieval decided are
 * relevant to this task.
 *
 * Until M15 this also carried hydrated code-symbol nodes and the edges
 * traversal chose to expand — spec.md §17's projection had five sections, four
 * of which described code. Those sections are gone with the structural graph
 * (§24, and the measurement behind it: `E2E_BENCHMARK_MULTI_REPO.md` found the
 * code half lost to grep, `WHY_MEMORY_SPIKE.md` found the memory half was the
 * part grep cannot reconstruct). The name `Subgraph` is kept because §17 and
 * §22 both refer to it, and because a set of memories retrieved for one task
 * is still exactly that: a slice of the memory graph.
 *
 * Building it is the caller's job — `buildContext` itself does no I/O, per
 * spec.md §17's "no new LLM call required" and ROADMAP's "plain templating
 * over the subgraph".
 */
export interface Subgraph {
  experiences?: Experience[];
}

export interface ExperienceSummary {
  experienceId: string;
  task: string;
  lessons: string[];
  result?: string;
  /**
   * `POSSIBLY_STALE_FLAG` when a commit has touched this memory's anchored
   * paths since it was recorded (spec.md §24.2.3), otherwise absent.
   *
   * The memory is still here — that is the point. §24.2.3 flags, never drops,
   * because `WHY_MEMORY_SPIKE.md` measured missing context as its own cost.
   * The agent reads the warning and decides whether to verify.
   */
  staleness?: string;
  /** Which change raised the flag, e.g. `modified src/parse.ts in a1b2c3d4`. */
  stalenessReason?: string;
}

/** spec.md §17's compact projection, as a structured object — `render.ts` turns this into the text an agent actually reads. */
export interface AgentContext {
  task: string;
  experiences: ExperienceSummary[];
}

export interface BuildContextOptions {
  /** Cap applied so the projection stays compact even if the caller hands in a larger-than-expected subgraph. */
  maxExperiences?: number;
}
