import { createHash } from "node:crypto";
import type { FunctionDeclaration, MethodDeclaration } from "ts-morph";

/**
 * Fingerprint a function/method by shape, deliberately excluding its name.
 *
 * This is what makes node identity (spec.md §3.2) survive a plain rename
 * without any special-case "is this a rename?" detection: the node id is
 * hash(repoId, filePath + kind + shapeFingerprint), so renaming a function
 * without touching its signature/body produces the same id automatically.
 *
 * Known limitation (acceptable at MVP scope, spec.md §3.2 anticipates a
 * fallback to delete+create when identity can't be proven): two distinct
 * same-shaped functions in the same file collide. A real LSP-backed rename
 * signal (tracked in ROADMAP.md as a v2 concern) removes the need for this
 * heuristic entirely.
 */
export function shapeFingerprint(
  fn: FunctionDeclaration | MethodDeclaration
): string {
  const params = fn
    .getParameters()
    .map((p) => p.getType().getText())
    .join(",");
  const returnType = fn.getReturnType().getText();
  const bodyText = fn.getBody()?.getText() ?? "";

  return createHash("sha256")
    .update(`${params}|${returnType}|${bodyText}`)
    .digest("hex")
    .slice(0, 16);
}
