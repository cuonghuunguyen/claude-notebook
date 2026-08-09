import type { FixtureNodeRef } from "./fixture.js";

export interface RetrievalEvalCase {
  query: string;
  expected: FixtureNodeRef;
  /** direct: expected node should surface from the lexical/vector legs. expansion: only reachable via spec.md §9 seed expansion. */
  kind: "direct" | "expansion";
}

/**
 * Hand-labeled (query -> expected node) pairs, spec.md ROADMAP M2
 * acceptance criterion / spec.md §19 point 1 (first slice of the retrieval
 * eval set). Kept here rather than in packages/retrieval so M7 can extend
 * this file into the full eval plan instead of starting over.
 */
export const RETRIEVAL_EVAL_CASES: RetrievalEvalCase[] = [
  // --- direct hits (lexical and/or vector leg) ---
  { query: "PaymentService", expected: "paymentService.class", kind: "direct" },
  { query: "payment service", expected: "paymentService.class", kind: "direct" },
  { query: "PaymentRepository", expected: "paymentRepository.class", kind: "direct" },
  { query: "payment repository", expected: "paymentRepository.class", kind: "direct" },
  { query: "charge amount", expected: "paymentService.method.charge", kind: "direct" },
  { query: "save amount", expected: "paymentRepository.method.save", kind: "direct" },
  { query: "computeSurcharge", expected: "utils.function.computeSurcharge", kind: "direct" },
  { query: "surcharge calculation", expected: "utils.function.computeSurcharge", kind: "direct" },
  { query: "publishEvent", expected: "eventBus.function.publishEvent", kind: "direct" },
  { query: "publish event", expected: "eventBus.function.publishEvent", kind: "direct" },
  { query: "formatDate", expected: "dateFormatter.function.formatDate", kind: "direct" },
  { query: "format date", expected: "dateFormatter.function.formatDate", kind: "direct" },
  {
    query: "PaymentEventOrderingInvariant",
    expected: "invariant.paymentEventOrder",
    kind: "direct",
  },
  { query: "payment event ordering", expected: "invariant.paymentEventOrder", kind: "direct" },
  { query: "paymentService.ts", expected: "file.paymentService", kind: "direct" },
  { query: "utils.ts", expected: "file.utils", kind: "direct" },

  // --- reachable only via 1-hop structural-neighbor expansion (spec.md §9) ---
  { query: "PaymentService", expected: "file.paymentService", kind: "expansion" },
  { query: "PaymentService", expected: "paymentService.method.charge", kind: "expansion" },
  { query: "charge amount", expected: "utils.function.computeSurcharge", kind: "expansion" },
  { query: "charge amount", expected: "paymentRepository.method.save", kind: "expansion" },
  { query: "charge amount", expected: "paymentService.class", kind: "expansion" },
  { query: "save amount", expected: "paymentService.method.charge", kind: "expansion" },

  // --- reachable only via semantic-neighbor expansion of a matched invariant ---
  { query: "payment event ordering", expected: "paymentService.class", kind: "expansion" },
];
