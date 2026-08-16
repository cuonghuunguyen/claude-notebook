/**
 * The shape of a benchmark target: a real-world repository the memory system
 * gets pointed at, plus the hand-labeled question set used to score it.
 *
 * The first version of this benchmark was hardcoded to zod. Making the target
 * pluggable is what lets the benchmark answer the question a single-repo run
 * can't: do the numbers hold on a codebase with a completely different shape,
 * or were they a property of zod?
 */

/** How many graph hops separate the question's wording from its answer. */
export type Hops =
  /** The question names the thing; the file is usually named after it too. */
  | "single"
  /**
   * The question describes a behaviour, and the code implementing it lives
   * behind one or more indirections whose names never appear in the question.
   * This is the regime a graph memory is supposed to win in, and the regime a
   * keyword grep is supposed to lose in.
   */
  | "multi";

export interface BenchmarkTask {
  id: string;
  /** The question as a developer/agent would actually phrase it. */
  question: string;
  /** File(s) a correct answer must point at. Suffix-matched with endsWith(). */
  expectedFiles: string[];
  /** Symbols a correct *answer* (agent run) should mention — grading aid. */
  expectedSymbols: string[];
  /** Undefined where the split wasn't part of the question set's design. */
  hops?: Hops;
}

/** A prior experience written to the graph at ingest time. */
export interface EpisodicSeed {
  /** Suffix of the file whose node the experience attaches to. */
  fileSuffix: string;
  lesson: string;
}

export interface BenchTarget {
  /** Short key used for BENCH_TARGET and the results directory. */
  key: string;
  /** repo_id the nodes are stored under — keeps targets isolated in one DB. */
  repoId: string;
  /** Where the clone comes from, for the report's reproduction section. */
  origin: string;
  /** Env var holding the path to the clone. */
  dirEnv: string;
  /** Path hint injected into agent prompts so answers name comparable paths. */
  agentPathHint: string;
  /**
   * ts-morph compiler options this target needs on top of `rootDir`.
   * Plain-JS targets need `allowJs` — without it the extractor throws inside
   * the TypeScript checker (see the benchmark report's finding on this).
   */
  compilerOptions?: Record<string, unknown>;
  /** Clone dir -> the directory actually indexed. */
  root(cloneDir: string): string;
  /** Globs handed to ts-morph, relative to `root`. */
  sourceGlobs(root: string): string[];
  /** The file list the grep baseline searches — same scope as sourceGlobs. */
  indexedFiles(root: string): string[];
  /** Optional synthetic experiences, to exercise the episodic read path. */
  episodicSeeds?: EpisodicSeed[];
  /** Default subset used by the agent comparison (it costs real money). */
  agentTaskIds: string[];
  tasks: BenchmarkTask[];
}
