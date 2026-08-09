import type { Edge } from "@cognitive-memory/core";

export type VerificationOutcome = "valid" | "invalid";

/**
 * Injected like retrieval's `EmbeddingProvider` (M2) and traversal's
 * `ReasoningProvider` (M5) — spec.md §12's lazy verification ("stale edge
 * retrieved -> verify against current code") is a pluggable check, not a
 * single hardcoded implementation. The real implementation
 * (`createStructuralVerifier`) checks structural liveness only; a scripted
 * fake is used in unit tests.
 */
export interface StructuralVerifier {
  verify(edge: Edge): Promise<VerificationOutcome>;
}
