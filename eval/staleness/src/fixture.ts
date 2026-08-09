import { randomUUID } from "node:crypto";
import type { Project } from "ts-morph";
import type { Node } from "@cognitive-memory/core";
import { extractProject, persistExtraction, projectFromSourceFiles } from "@cognitive-memory/structural";
import { appendEvent, upsertNode } from "@cognitive-memory/graph-store";
import { recordObservation } from "@cognitive-memory/semantic";

export const FIXTURE_PATH = "/src/service.ts";

export const FIXTURE_SOURCE = `
  export function helper(x: number): number {
    return x + 1;
  }

  export function untouched(y: number): number {
    return y * 2;
  }
`;

function findNode(nodes: Node[], type: Node["type"], name: string): Node {
  const found = nodes.find((n) => n.type === type && n.name === name);
  if (!found) throw new Error(`eval/staleness fixture: expected node type=${type} name=${name} not found`);
  return found;
}

export interface StalenessFixture {
  repoId: string;
  project: Project;
  helperId: string;
  untouchedId: string;
  helperInvariantId: string;
  untouchedInvariantId: string;
}

/**
 * spec.md §19 point 2's injected-refactor eval needs a real semantic edge
 * (not just structural ones — structural edges are re-derived fresh on
 * every extraction pass, so they never observably stay stale) attached to
 * each of two functions, so a refactor to one and not the other can prove
 * "expected edges flip to stale and no unrelated edges do." Two invariant
 * nodes, one per function, keep the two edges independent — sharing one
 * target would make "unrelated" ambiguous (the target itself touches both).
 */
export async function buildStalenessFixture(): Promise<StalenessFixture> {
  const repoId = `staleness-eval-${randomUUID()}`;
  const project = projectFromSourceFiles({ [FIXTURE_PATH]: FIXTURE_SOURCE });
  const result = extractProject(project, repoId);
  await persistExtraction(result, repoId);

  const helper = findNode(result.nodes, "function", "helper");
  const untouched = findNode(result.nodes, "function", "untouched");

  const now = new Date().toISOString();
  const helperInvariantId = `${repoId}-invariant-helper`;
  const untouchedInvariantId = `${repoId}-invariant-untouched`;

  for (const [id, name] of [
    [helperInvariantId, "HelperInvariant"],
    [untouchedInvariantId, "UntouchedInvariant"],
  ] as const) {
    const invariantNode = {
      id,
      type: "invariant" as const,
      name,
      metadata: {},
      provenance: [{ sourceType: "llm_inference" as const, sourceId: "eval-fixture", confidence: 0.8, observedAt: now }],
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    };
    await upsertNode(invariantNode, repoId);
    // Every node this fixture creates goes through the event log (spec.md
    // §14) — a node created outside it would make graph-store's
    // rebuild-from-events replay unable to satisfy the RelationAdded event
    // below (its `to_id` FK has nothing to reference on a fresh replay).
    await appendEvent({ eventType: "SymbolAdded", payload: { node: invariantNode, repoId } });
  }

  // Two corroborating observations each, from distinct sourceTypes, so both
  // edges reach "candidate" (spec.md §7) — a real semantic fact, not a lone
  // unpromoted observation, is what should be at risk of going stale.
  for (const [fromId, toId] of [
    [helper.id, helperInvariantId],
    [untouched.id, untouchedInvariantId],
  ] as const) {
    await recordObservation(fromId, toId, "constrained_by", {
      sourceType: "source_code",
      sourceId: FIXTURE_PATH,
      confidence: 0.7,
      observedAt: now,
    });
    await recordObservation(fromId, toId, "constrained_by", {
      sourceType: "documentation",
      sourceId: "README",
      confidence: 0.7,
      observedAt: now,
    });
  }

  return {
    repoId,
    project,
    helperId: helper.id,
    untouchedId: untouched.id,
    helperInvariantId,
    untouchedInvariantId,
  };
}
