import path from "node:path";

export function repoDir(): string {
  const dir = process.env["ZOD_DIR"];
  if (!dir) throw new Error("ZOD_DIR must point at a full (non-shallow) clone of colinhacks/zod");
  return dir;
}

/** Repo-relative path the history is mined for — same scope the graph indexes. */
export function pathScope(): string {
  return "packages/zod/src/v4";
}

export function resultsDir(): string {
  return process.env["SPIKE_RESULTS_DIR"] ?? path.join(process.cwd(), "results");
}
