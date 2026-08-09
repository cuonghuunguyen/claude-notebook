import { randomUUID } from "node:crypto";
import type { Node } from "@cognitive-memory/core";
import { upsertEdgeByTriple, upsertNode } from "@cognitive-memory/graph-store";
import { extractProject, persistExtraction, projectFromSourceFiles } from "@cognitive-memory/structural";

const FILES: Record<string, string> = {
  "/src/paymentService.ts": `
    import { computeSurcharge } from "./utils";
    import { PaymentRepository } from "./paymentRepository";

    export class PaymentService {
      private repo: PaymentRepository;

      constructor(repo: PaymentRepository) {
        this.repo = repo;
      }

      charge(amount: number): number {
        const total = amount + computeSurcharge(amount);
        return this.repo.save(total);
      }
    }
  `,
  "/src/paymentRepository.ts": `
    export class PaymentRepository {
      save(amount: number): number {
        return amount;
      }
    }
  `,
  "/src/utils.ts": `
    export function computeSurcharge(amount: number): number {
      return amount * 0.1;
    }
  `,
  "/src/eventBus.ts": `
    export function publishEvent(name: string): void {
      console.log(name);
    }
  `,
  "/src/dateFormatter.ts": `
    export function formatDate(date: Date): string {
      return date.toISOString();
    }
  `,
};

/** Symbolic names used by eval/retrieval/src/cases.ts to refer to fixture nodes. */
export type FixtureNodeRef =
  | "paymentService.class"
  | "paymentService.method.charge"
  | "paymentRepository.class"
  | "paymentRepository.method.save"
  | "utils.function.computeSurcharge"
  | "eventBus.function.publishEvent"
  | "dateFormatter.function.formatDate"
  | "file.paymentService"
  | "file.utils"
  | "invariant.paymentEventOrder";

export interface RetrievalFixture {
  repoId: string;
  nodeIds: Record<FixtureNodeRef, string>;
  allNodes: Node[];
}

function findNode(nodes: Node[], type: Node["type"], name: string): Node {
  const found = nodes.find((n) => n.type === type && n.name === name);
  if (!found) throw new Error(`eval fixture: expected node type=${type} name=${name} not found`);
  return found;
}

/**
 * Builds the M2 eval fixture: a small PaymentService domain extracted
 * through the real M1 pipeline (spec.md ROADMAP M2 acceptance: "eval
 * fixture ... against the M1 fixture project"), plus one synthetic
 * invariant node/edge. Concept/invariant nodes don't exist until M3's
 * promotion pipeline ships, but spec.md §9's seed expansion has a dedicated
 * path for them ("highest-weight semantic neighbors of any matched
 * concept/invariant node") that this milestone's acceptance criteria must
 * still cover — so this fixture inserts one directly via graph-store rather
 * than waiting on M3.
 */
export async function buildRetrievalFixture(): Promise<RetrievalFixture> {
  const repoId = `retrieval-eval-${randomUUID()}`;
  const project = projectFromSourceFiles(FILES);
  const result = extractProject(project, repoId);
  await persistExtraction(result, repoId);

  const paymentServiceClass = findNode(result.nodes, "class", "PaymentService");
  const chargeMethod = findNode(result.nodes, "method", "charge");
  const paymentRepositoryClass = findNode(result.nodes, "class", "PaymentRepository");
  const saveMethod = findNode(result.nodes, "method", "save");
  const computeSurchargeFn = findNode(result.nodes, "function", "computeSurcharge");
  const publishEventFn = findNode(result.nodes, "function", "publishEvent");
  const formatDateFn = findNode(result.nodes, "function", "formatDate");
  const paymentServiceFile = findNode(result.nodes, "file", "/src/paymentService.ts");
  const utilsFile = findNode(result.nodes, "file", "/src/utils.ts");

  const now = new Date().toISOString();
  const invariantId = `${repoId}-invariant-payment-event-order`;
  const invariantNode: Node = {
    id: invariantId,
    type: "invariant",
    name: "PaymentEventOrderingInvariant",
    summary: "Payment event ordering: publish only after the database commit.",
    metadata: { keywords: ["payment", "event", "ordering", "commit"] },
    provenance: [
      { sourceType: "llm_inference", sourceId: "eval-fixture", confidence: 0.8, observedAt: now },
    ],
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  await upsertNode(invariantNode, repoId);
  await upsertEdgeByTriple({
    id: randomUUID(),
    from: paymentServiceClass.id,
    to: invariantId,
    relation: "constrained_by",
    confidence: 0.8,
    weight: 0.9,
    provenance: invariantNode.provenance,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });

  const nodeIds: Record<FixtureNodeRef, string> = {
    "paymentService.class": paymentServiceClass.id,
    "paymentService.method.charge": chargeMethod.id,
    "paymentRepository.class": paymentRepositoryClass.id,
    "paymentRepository.method.save": saveMethod.id,
    "utils.function.computeSurcharge": computeSurchargeFn.id,
    "eventBus.function.publishEvent": publishEventFn.id,
    "dateFormatter.function.formatDate": formatDateFn.id,
    "file.paymentService": paymentServiceFile.id,
    "file.utils": utilsFile.id,
    "invariant.paymentEventOrder": invariantId,
  };

  return { repoId, nodeIds, allNodes: [...result.nodes, invariantNode] };
}
