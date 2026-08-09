import { describe, expect, it } from "vitest";
import { extractProject, projectFromSourceFiles } from "./extract.js";

const REPO = "fixture-repo";

describe("extractProject", () => {
  it("extracts file, function, class, method nodes and contains/calls/imports edges", () => {
    const project = projectFromSourceFiles({
      "/src/bar.ts": `
        export function helper(x: number): number {
          return x + 1;
        }
      `,
      "/src/foo.ts": `
        import { helper } from "./bar";

        export class FooService {
          run(x: number): number {
            return helper(x);
          }
        }
      `,
    });

    const { nodes, edges } = extractProject(project, REPO);

    const byType = (t: string) => nodes.filter((n) => n.type === t);
    expect(byType("file")).toHaveLength(2);
    expect(byType("function")).toHaveLength(1);
    expect(byType("class")).toHaveLength(1);
    expect(byType("method")).toHaveLength(1);

    expect(nodes.find((n) => n.type === "function")?.name).toBe("helper");
    expect(nodes.find((n) => n.type === "class")?.name).toBe("FooService");
    expect(nodes.find((n) => n.type === "method")?.name).toBe("run");

    const relations = edges.map((e) => e.relation);
    expect(relations.filter((r) => r === "contains")).toHaveLength(3); // file->fn, file->class, class->method
    expect(relations).toContain("imports");
    expect(relations).toContain("calls");

    const callEdge = edges.find((e) => e.relation === "calls");
    const methodNode = nodes.find((n) => n.type === "method");
    const fnNode = nodes.find((n) => n.type === "function");
    expect(callEdge?.from).toBe(methodNode?.id);
    expect(callEdge?.to).toBe(fnNode?.id);
  });

  it("gives every node/edge source_code provenance at confidence 1", () => {
    const project = projectFromSourceFiles({
      "/src/a.ts": `export function a() { return 1; }`,
    });
    const { nodes, edges } = extractProject(project, REPO);
    for (const n of [...nodes, ...edges]) {
      expect(n.provenance[0]?.sourceType).toBe("source_code");
      expect(n.provenance[0]?.confidence).toBe(1);
    }
  });
});

describe("node identity across edits (spec.md §3.2)", () => {
  it("a plain rename (same file, same shape, different name) keeps the same node id", () => {
    const before = extractProject(
      projectFromSourceFiles({
        "/src/foo.ts": `export function computeTotal(x: number): number { return x * 2; }`,
      }),
      REPO
    );
    const after = extractProject(
      projectFromSourceFiles({
        "/src/foo.ts": `export function computeGrandTotal(x: number): number { return x * 2; }`,
      }),
      REPO
    );

    const beforeFn = before.nodes.find((n) => n.type === "function");
    const afterFn = after.nodes.find((n) => n.type === "function");
    expect(afterFn?.id).toBe(beforeFn?.id); // identity preserved
    expect(afterFn?.name).toBe("computeGrandTotal"); // display name did change
  });

  it("changing the name AND moving to a different file with no rename signal is a delete+create", () => {
    const before = extractProject(
      projectFromSourceFiles({
        "/src/foo.ts": `export function computeTotal(x: number): number { return x * 2; }`,
      }),
      REPO
    );
    const after = extractProject(
      projectFromSourceFiles({
        "/src/bar.ts": `export function computeGrandTotal(x: number): number { return x * 3; }`,
      }),
      REPO
    );

    const beforeFn = before.nodes.find((n) => n.type === "function");
    const afterFn = after.nodes.find((n) => n.type === "function");
    expect(afterFn?.id).not.toBe(beforeFn?.id); // different file + different shape => new identity
  });

  it("moving an UNCHANGED function to a different file is still a new identity (path is part of id)", () => {
    const src = `export function computeTotal(x: number): number { return x * 2; }`;
    const before = extractProject(projectFromSourceFiles({ "/src/foo.ts": src }), REPO);
    const after = extractProject(projectFromSourceFiles({ "/src/bar.ts": src }), REPO);

    const beforeFn = before.nodes.find((n) => n.type === "function");
    const afterFn = after.nodes.find((n) => n.type === "function");
    // Known MVP limitation documented in shape.ts / spec.md §3.2: without a
    // real LSP rename/move signal, a cross-file move is indistinguishable
    // from delete+create even when the shape is identical.
    expect(afterFn?.id).not.toBe(beforeFn?.id);
  });
});
