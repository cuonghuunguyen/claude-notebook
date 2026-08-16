/**
 * Shared configuration for the e2e benchmark: which real-world repo gets
 * indexed and where results land.
 *
 * Targets are cloned by the harness user outside this repository — see
 * eval/e2e-benchmark/README.md. Which one is active comes from BENCH_TARGET
 * (default `zod`), and each target reads its clone path from its own env var,
 * so the benchmark is re-runnable on any machine.
 */
import path from "node:path";
import { activeTarget } from "./targets/index.js";

export { activeTarget, targetDir, targetRoot } from "./targets/index.js";
export type { BenchTarget, BenchmarkTask, Hops } from "./targets/index.js";

/**
 * Results are per-target (`results/<key>/`). The original single-target zod
 * run's files stay at `results/` top level — they are the evidence behind
 * E2E_BENCHMARK_REPORT.md and moving them would break that report's citations.
 */
export function resultsDir(): string {
  return (
    process.env["BENCH_RESULTS_DIR"] ??
    path.join(process.cwd(), "results", activeTarget().key)
  );
}
