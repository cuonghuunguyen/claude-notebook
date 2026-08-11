/**
 * Shared configuration for the e2e benchmark: which real-world repo gets
 * indexed, under what repoId, and where results land.
 *
 * The target repo (zod v4) is cloned by the harness user outside this
 * repository — see eval/e2e-benchmark/README.md. Everything here reads it
 * from ZOD_DIR so the benchmark is re-runnable on any machine.
 */
import path from "node:path";

export const REPO_ID = "zod-v4-benchmark";

export function zodRoot(): string {
  const dir = process.env["ZOD_DIR"];
  if (!dir) {
    throw new Error(
      "ZOD_DIR must point at a clone of github.com/colinhacks/zod " +
        "(the benchmark indexes packages/zod/src/v4/{classic,core})"
    );
  }
  return path.join(dir, "packages", "zod", "src", "v4");
}

export function resultsDir(): string {
  return process.env["BENCH_RESULTS_DIR"] ?? path.join(process.cwd(), "results");
}

/** Indexed scope: classic + core, tests excluded — what an agent memory would index. */
export function sourceGlobs(root: string): string[] {
  return [
    `${root}/classic/**/*.ts`,
    `${root}/core/**/*.ts`,
    `!${root}/classic/tests/**`,
    `!${root}/core/tests/**`,
  ];
}
