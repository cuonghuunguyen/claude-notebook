import { describe, expect, it } from "vitest";
import type { Edge, Experience, Node } from "@cognitive-memory/core";
import { buildContext } from "./build.js";
import { renderContext } from "./render.js";
import type { Subgraph } from "./types.js";

const NOW = new Date().toISOString();

function node(id: string, overrides: Partial<Node> = {}): Node {
  return {
    id,
    type: "function",
    metadata: {},
    provenance: [],
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function edge(id: string, from: string, to: string, overrides: Partial<Edge> = {}): Edge {
  return {
    id,
    from,
    to,
    relation: "calls",
    confidence: 1,
    weight: 0.5,
    provenance: [],
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/**
 * A fixed, realistic subgraph — the shape M5's traversal would hand off for
 * a task like "how does PaymentService persist a payment record": a
 * subsystem, the two files involved, the class/method pair, an invariant
 * constraining `save()`, and two prior experiences touching `save()`.
 */
const FIXTURE_SUBGRAPH: Subgraph = {
  nodes: [
    node("payments-subsystem", {
      type: "subsystem",
      name: "Payments",
      summary: "Handles payment capture and persistence.",
    }),
    node("file-payment-service", {
      type: "file",
      path: "src/payments/PaymentService.ts",
      summary: "Payment capture entrypoint.",
    }),
    node("file-payment-repo", {
      type: "file",
      path: "src/payments/PaymentRepository.ts",
      summary: "Persists payment records.",
    }),
    node("payment-service", { type: "class", name: "PaymentService", summary: "Orchestrates payment capture." }),
    node("repo-save", { type: "method", name: "save", summary: "Writes a payment record to the database." }),
    node("invariant-idempotent", {
      type: "invariant",
      name: "Payment writes are idempotent",
      summary: "Retrying save() with the same payment id must not create a duplicate record.",
    }),
  ],
  edges: [
    edge("edge-calls", "payment-service", "repo-save", { relation: "calls", confidence: 1, weight: 0.9 }),
    edge("edge-constraint", "payment-service", "invariant-idempotent", {
      relation: "constrained_by",
      confidence: 0.95,
      weight: 0.8,
    }),
    edge("edge-contains", "file-payment-service", "payment-service", { relation: "contains", weight: 0.6 }),
    edge("edge-contains-2", "file-payment-repo", "repo-save", { relation: "contains", weight: 0.6 }),
  ],
  experiences: [
    {
      id: "exp-1",
      task: "fix double-charge bug",
      observation: "save() was called twice for the same payment under retry.",
      lessons: ["save() must check for an existing record by payment id before inserting"],
      result: "Added an idempotency check keyed on payment id; regression test added.",
      relatedNodes: ["repo-save"],
      confidence: 0.9,
      timestamp: "2026-01-15T00:00:00.000Z",
    },
    {
      id: "exp-2",
      task: "investigate slow payment writes",
      observation: "save() was doing a full table scan to check for duplicates.",
      lessons: [],
      result: "Added an index on payment_id; write latency dropped 80%.",
      relatedNodes: ["repo-save"],
      confidence: 0.8,
      timestamp: "2026-02-01T00:00:00.000Z",
    },
  ] satisfies Experience[],
};

describe("renderContext", () => {
  it("renders a fixed subgraph fixture to a compact-context snapshot", () => {
    const context = buildContext(FIXTURE_SUBGRAPH, "how does PaymentService persist a payment record");
    expect(renderContext(context)).toMatchSnapshot();
  });
});
