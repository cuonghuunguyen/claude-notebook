import { describe, expect, it } from "vitest";
import { extractProject, projectFromSourceFiles } from "./extract.js";

const REPO = "fixture-repo";

describe("extractProject", () => {
  it("extracts file, function, class, method nodes and contains/calls/imports edges", () => {
    const project = projectFromSourceFiles({
      "/src/bar.py": `
def helper(x):
    return x + 1
`,
      "/src/foo.py": `
from .bar import helper


class FooService:
    def run(self, x):
        return helper(x)
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
      "/src/a.py": `def a():\n    return 1\n`,
    });
    const { nodes, edges } = extractProject(project, REPO);
    for (const n of [...nodes, ...edges]) {
      expect(n.provenance[0]?.sourceType).toBe("source_code");
      expect(n.provenance[0]?.confidence).toBe(1);
    }
  });

  it("tags every node's metadata with language: python", () => {
    const project = projectFromSourceFiles({
      "/src/a.py": `def a():\n    return 1\n`,
    });
    const { nodes } = extractProject(project, REPO);
    for (const n of nodes) {
      expect(n.metadata.language).toBe("python");
    }
  });

  it("resolves a decorated method call via self", () => {
    const project = projectFromSourceFiles({
      "/src/svc.py": `
class Service:
    @staticmethod
    def helper(x):
        return x * 2

    def run(self, x):
        return self.helper(x)
`,
    });
    const { nodes, edges } = extractProject(project, REPO);
    const helperNode = nodes.find((n) => n.name === "helper");
    const runNode = nodes.find((n) => n.name === "run");
    const callEdge = edges.find((e) => e.relation === "calls");
    expect(callEdge?.from).toBe(runNode?.id);
    expect(callEdge?.to).toBe(helperNode?.id);
  });

  it("resolves a call to a name imported via a bare (non-relative) module import", () => {
    const project = projectFromSourceFiles({
      "/src/util.py": `def double(x):\n    return x * 2\n`,
      "/src/main.py": `
from util import double


def run(x):
    return double(x)
`,
    });
    const { nodes, edges } = extractProject(project, REPO);
    const doubleNode = nodes.find((n) => n.name === "double");
    const runNode = nodes.find((n) => n.name === "run");
    const callEdge = edges.find((e) => e.relation === "calls");
    expect(callEdge?.from).toBe(runNode?.id);
    expect(callEdge?.to).toBe(doubleNode?.id);
    expect(edges.some((e) => e.relation === "imports")).toBe(true);
  });

  it("resolves a bare relative submodule import (`from . import bar`) to a file-level imports edge", () => {
    const project = projectFromSourceFiles({
      "/src/pkg/bar.py": `def helper(x):\n    return x + 1\n`,
      "/src/pkg/foo.py": `
from . import bar


def run(x):
    return bar.helper(x)
`,
    });
    const { nodes, edges } = extractProject(project, REPO);
    const barFile = nodes.find((n) => n.type === "file" && n.path === "/src/pkg/bar.py");
    const fooFile = nodes.find((n) => n.type === "file" && n.path === "/src/pkg/foo.py");
    expect(
      edges.some((e) => e.relation === "imports" && e.from === fooFile?.id && e.to === barFile?.id)
    ).toBe(true);
  });

  it("does not resolve a call on an object of unknown type (MVP limitation, same as ts-morph extractor)", () => {
    const project = projectFromSourceFiles({
      "/src/a.py": `
class Widget:
    def render(self):
        return 1


def run(w):
    return w.render()
`,
    });
    const { edges } = extractProject(project, REPO);
    expect(edges.some((e) => e.relation === "calls")).toBe(false);
  });
});

describe("node identity across edits (spec.md §3.2, extended by §21)", () => {
  it("a plain rename (same file, same shape, different name) keeps the same node id", () => {
    const before = extractProject(
      projectFromSourceFiles({
        "/src/foo.py": `def compute_total(x):\n    return x * 2\n`,
      }),
      REPO
    );
    const after = extractProject(
      projectFromSourceFiles({
        "/src/foo.py": `def compute_grand_total(x):\n    return x * 2\n`,
      }),
      REPO
    );

    const beforeFn = before.nodes.find((n) => n.type === "function");
    const afterFn = after.nodes.find((n) => n.type === "function");
    expect(afterFn?.id).toBe(beforeFn?.id); // identity preserved
    expect(afterFn?.name).toBe("compute_grand_total"); // display name did change
  });

  it("changing the name AND moving to a different file with no rename signal is a delete+create", () => {
    const before = extractProject(
      projectFromSourceFiles({
        "/src/foo.py": `def compute_total(x):\n    return x * 2\n`,
      }),
      REPO
    );
    const after = extractProject(
      projectFromSourceFiles({
        "/src/bar.py": `def compute_grand_total(x):\n    return x * 3\n`,
      }),
      REPO
    );

    const beforeFn = before.nodes.find((n) => n.type === "function");
    const afterFn = after.nodes.find((n) => n.type === "function");
    expect(afterFn?.id).not.toBe(beforeFn?.id); // different file + different shape => new identity
  });

  it("moving an UNCHANGED function to a different file is still a new identity (path is part of id)", () => {
    const src = `def compute_total(x):\n    return x * 2\n`;
    const before = extractProject(projectFromSourceFiles({ "/src/foo.py": src }), REPO);
    const after = extractProject(projectFromSourceFiles({ "/src/bar.py": src }), REPO);

    const beforeFn = before.nodes.find((n) => n.type === "function");
    const afterFn = after.nodes.find((n) => n.type === "function");
    expect(afterFn?.id).not.toBe(beforeFn?.id);
  });
});
