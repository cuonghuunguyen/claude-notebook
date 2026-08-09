import type { ReasoningContext, ReasoningProvider, ReasoningResult } from "./types.js";

/**
 * Scripted fake reasoning provider for tests (spec.md ROADMAP M5: "testable
 * with a scripted fake decision-maker, not a live LLM, in unit tests") — the
 * same role `fakeEmbedder` plays for retrieval's injected embedder. `script`
 * is called once per `decide()` invocation (i.e. once per depth level
 * reached) with the zero-based call index, so a test can assert exactly how
 * many times reasoning ran without depending on edge count.
 */
export interface ScriptedReasoner extends ReasoningProvider {
  readonly callCount: number;
}

export function createScriptedReasoner(
  script: (context: ReasoningContext, callIndex: number) => ReasoningResult
): ScriptedReasoner {
  let callCount = 0;
  return {
    get callCount() {
      return callCount;
    },
    async decide(context: ReasoningContext): Promise<ReasoningResult> {
      const result = script(context, callCount);
      callCount += 1;
      return result;
    },
  };
}

/** Convenience script: expand every candidate offered, never stop early — useful for budget-exhaustion tests where the interesting bound is the budget, not the reasoning policy. */
export function expandAllReasoner(): ScriptedReasoner {
  return createScriptedReasoner((context) => ({
    decisions: context.candidates.map((c) => ({ edgeId: c.edgeId, action: "expand" })),
    stop: false,
  }));
}
