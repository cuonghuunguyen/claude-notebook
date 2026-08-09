import { randomUUID } from "node:crypto";
import type { Node } from "@cognitive-memory/core";
import { extractProject, persistExtraction, projectFromSourceFiles } from "@cognitive-memory/structural";

const FILES: Record<string, string> = {
  "/src/pipeline.ts": `
    import { stepA } from "./stepA";
    export function main(): void {
      stepA();
    }
  `,
  "/src/stepA.ts": `
    import { stepB } from "./stepB";
    export function stepA(): void {
      stepB();
    }
  `,
  "/src/stepB.ts": `
    import { stepC } from "./stepC";
    export function stepB(): void {
      stepC();
    }
  `,
  "/src/stepC.ts": `
    export function stepC(): void {
      console.log("done");
    }
  `,
  "/src/noise.ts": `
    export function noise(): void {}
  `,
};

function findNode(nodes: Node[], type: Node["type"], name: string): Node {
  const found = nodes.find((n) => n.type === type && n.name === name);
  if (!found) throw new Error(`eval/traversal-cost fixture: expected node type=${type} name=${name} not found`);
  return found;
}

export interface TraversalCostFixture {
  repoId: string;
  mainId: string;
  stepAId: string;
  stepBId: string;
  stepCId: string;
  noiseId: string;
}

/**
 * A small call chain (main -> stepA -> stepB -> stepC) plus one isolated
 * function (noise) with no edges into the chain — spec.md §19 point 4's
 * traversal-cost eval needs a real, bounded subgraph small enough that a
 * well-tuned default budget (spec.md §10.1) terminates naturally (STOP via
 * no_frontier/no_expansion) well before exhausting it, so a run that DOES
 * hit `budget_exhausted` on this fixture is a meaningful signal, not noise
 * from an oversized graph.
 */
export async function buildTraversalCostFixture(): Promise<TraversalCostFixture> {
  const repoId = `traversal-cost-eval-${randomUUID()}`;
  const project = projectFromSourceFiles(FILES);
  const result = extractProject(project, repoId);
  await persistExtraction(result, repoId);

  return {
    repoId,
    mainId: findNode(result.nodes, "function", "main").id,
    stepAId: findNode(result.nodes, "function", "stepA").id,
    stepBId: findNode(result.nodes, "function", "stepB").id,
    stepCId: findNode(result.nodes, "function", "stepC").id,
    noiseId: findNode(result.nodes, "function", "noise").id,
  };
}
