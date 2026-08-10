import { createHash } from "node:crypto";
import type { SyntaxNode } from "tree-sitter";

/**
 * Fingerprint a Python function/method by shape, deliberately excluding its
 * name — the tree-sitter analog of packages/structural's shapeFingerprint.
 * Same rationale (spec.md §3.2): node id = hash(repoId, filePath + kind +
 * shapeFingerprint), so a plain rename survives without special-case
 * detection. tree-sitter has no type checker, so "shape" here is parameter
 * list text (including any annotations actually written) + return-type
 * annotation text (if present) + body text, instead of ts-morph's
 * checker-resolved types.
 *
 * Same known MVP limitation as the TS/JS extractor: two distinct
 * same-shaped functions in the same file collide.
 */
export function shapeFingerprint(fn: SyntaxNode): string {
  const params = fn.childForFieldName("parameters")?.text ?? "";
  const returnType = fn.childForFieldName("return_type")?.text ?? "";
  const body = fn.childForFieldName("body")?.text ?? "";

  return createHash("sha256")
    .update(`${params}|${returnType}|${body}`)
    .digest("hex")
    .slice(0, 16);
}
