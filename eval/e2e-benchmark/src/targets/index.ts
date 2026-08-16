import type { BenchTarget } from "./types.js";
import { lodashTarget } from "./lodash.js";
import { zodTarget } from "./zod.js";

export * from "./types.js";
export { lodashTarget, zodTarget };

export const TARGETS: Record<string, BenchTarget> = {
  [zodTarget.key]: zodTarget,
  [lodashTarget.key]: lodashTarget,
};

/**
 * Defaults to zod so every command documented for the original single-target
 * benchmark keeps working unchanged.
 */
export function activeTarget(): BenchTarget {
  const key = process.env["BENCH_TARGET"] ?? "zod";
  const target = TARGETS[key];
  if (!target) {
    throw new Error(
      `unknown BENCH_TARGET "${key}" (known: ${Object.keys(TARGETS).join(", ")})`
    );
  }
  return target;
}

/** The clone directory for `target`, from its own env var. */
export function targetDir(target: BenchTarget): string {
  const dir = process.env[target.dirEnv];
  if (!dir) {
    throw new Error(`${target.dirEnv} must point at a clone of ${target.origin}`);
  }
  return dir;
}

/** The directory actually indexed (may be a subdirectory of the clone). */
export function targetRoot(target: BenchTarget): string {
  return target.root(targetDir(target));
}
