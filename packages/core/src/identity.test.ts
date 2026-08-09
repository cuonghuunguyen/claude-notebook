import { describe, expect, it } from "vitest";
import { nodeId } from "./identity.js";

describe("nodeId", () => {
  it("is deterministic for the same repo + symbol path", () => {
    const a = nodeId("repo-1", "src/foo.ts#FooService");
    const b = nodeId("repo-1", "src/foo.ts#FooService");
    expect(a).toBe(b);
  });

  it("is stable across an unrelated line-number shift (path excludes line/col)", () => {
    // Callers must pass a stable symbol path, never "file:line" — this test
    // documents that nodeId itself has no line/col in its inputs at all.
    const a = nodeId("repo-1", "src/foo.ts#FooService");
    const b = nodeId("repo-1", "src/foo.ts#FooService");
    expect(a).toBe(b);
  });

  it("differs across repos for the same symbol path", () => {
    const a = nodeId("repo-1", "src/foo.ts#FooService");
    const b = nodeId("repo-2", "src/foo.ts#FooService");
    expect(a).not.toBe(b);
  });

  it("differs across symbol paths in the same repo", () => {
    const a = nodeId("repo-1", "src/foo.ts#FooService");
    const b = nodeId("repo-1", "src/bar.ts#BarService");
    expect(a).not.toBe(b);
  });
});
