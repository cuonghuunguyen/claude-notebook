import { describe, expect, it } from "vitest";
import type { Experience } from "@cognitive-memory/core";
import { buildContext } from "./build.js";
import { renderContext } from "./render.js";
import type { Subgraph } from "./types.js";

/**
 * A fixed, realistic subgraph — the shape §24.2.1's by-meaning retrieval hands
 * off for a task like "how does PaymentService persist a payment record": the
 * memories written while the double-charge bug and the slow-write
 * investigation were worked on, one of which the history has since overtaken.
 *
 * Before M15 this fixture also carried the subsystem, files, class/method and
 * invariant nodes traversal would have reached, and the rendered snapshot had
 * five sections. Four of them described the code — which the agent reading the
 * context already has, and which grep reconstructs better than the graph did
 * (`E2E_BENCHMARK_MULTI_REPO.md`). The section that survived is the one grep
 * cannot produce.
 */
const FIXTURE_SUBGRAPH: Subgraph = {
  experiences: [
    {
      id: "exp-1",
      task: "fix double-charge bug",
      observation: "save() was called twice for the same payment under retry.",
      lessons: ["save() must check for an existing record by payment id before inserting"],
      result: "Added an idempotency check keyed on payment id; regression test added.",
      relatedNodes: ["src/payments/PaymentRepository.ts"],
      anchors: [{ path: "src/payments/PaymentRepository.ts", symbol: "save" }],
      confidence: 0.9,
      timestamp: "2026-01-15T00:00:00.000Z",
    },
    {
      id: "exp-2",
      task: "investigate slow payment writes",
      observation: "save() was doing a full table scan to check for duplicates.",
      lessons: [],
      result: "Added an index on payment_id; write latency dropped 80%.",
      relatedNodes: ["src/payments/PaymentRepository.ts"],
      anchors: [{ path: "src/payments/PaymentRepository.ts", symbol: "save" }],
      confidence: 0.8,
      timestamp: "2026-02-01T00:00:00.000Z",
      suspect: true,
      suspectReason: "modified src/payments/PaymentRepository.ts in 9f2c1a0b",
    },
  ] satisfies Experience[],
};

describe("renderContext", () => {
  it("renders a fixed subgraph fixture to a compact-context snapshot", () => {
    const context = buildContext(FIXTURE_SUBGRAPH, "how does PaymentService persist a payment record");
    expect(renderContext(context)).toMatchSnapshot();
  });

  it("says so explicitly when the memory has nothing for this task", () => {
    const rendered = renderContext(buildContext({ experiences: [] }, "a task nothing was ever recorded about"));
    expect(rendered).toContain("# Context: a task nothing was ever recorded about");
    expect(rendered).toContain("_No prior knowledge recorded for this task._");
  });
});
