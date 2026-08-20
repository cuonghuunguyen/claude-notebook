import path from "node:path";

/**
 * The spike reuses `eval/why-spike`'s corpus deliberately: the same repo, the
 * same path scope, the same memories. M14 asks whether *edges between* those
 * memories buy anything, so changing the corpus at the same time would make
 * the answer uninterpretable.
 */
export function repoDir(): string {
  const dir = process.env["ZOD_DIR"];
  if (!dir) throw new Error("ZOD_DIR must point at a full (non-shallow) clone of colinhacks/zod");
  return dir;
}

export function pathScope(): string {
  return process.env["LINK_SPIKE_SCOPE"] ?? "packages/zod/src/v4";
}

/** How far back `git log` walks. 400 is `packages/capture`'s default and the why-spike's value. */
export function commitLimit(): number {
  return Number(process.env["LINK_SPIKE_LIMIT"] ?? 400);
}

export function resultsDir(): string {
  return process.env["LINK_SPIKE_RESULTS_DIR"] ?? path.join(process.cwd(), "results");
}

export function labelsDir(): string {
  return process.env["LINK_SPIKE_LABELS_DIR"] ?? path.join(process.cwd(), "labels");
}
