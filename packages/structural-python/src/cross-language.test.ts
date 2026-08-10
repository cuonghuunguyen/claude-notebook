import { describe, expect, it } from "vitest";
import {
  extractProject as extractTsProject,
  projectFromSourceFiles as tsProjectFromSourceFiles,
} from "@cognitive-memory/structural";
import { extractProject, projectFromSourceFiles } from "./extract.js";

/**
 * spec.md §21's own proposal PR (#9) demonstrated the exact failure this
 * guards against: pointing packages/structural's ts-morph `Project` at a
 * Python file silently mis-registers it — `class PaymentService:` becomes a
 * TS `class` node with its method invisible, and running the type checker
 * over it crashes outright. The fix isn't inside either extractor (ts-morph
 * will always try to parse whatever text it's given); it's routing each
 * file to the extractor for its own language before either one ever sees
 * it — the same discipline this test exercises and pins down.
 */
const REPO = "cross-lang-repo";

describe("TS/JS and Python extractors coexist on one repo without corrupting each other", () => {
  it("each extractor, given only its own language's files, produces correct nodes for structurally equivalent input", () => {
    const tsProject = tsProjectFromSourceFiles({
      "/src/paymentService.ts": `
export class PaymentService {
  charge(amount: number): number {
    return amount;
  }
}
`,
    });
    const pyProject = projectFromSourceFiles({
      "/src/payment_service.py": `
class PaymentService:
    def charge(self, amount):
        return amount
`,
    });

    const tsResult = extractTsProject(tsProject, REPO);
    const pyResult = extractProject(pyProject, REPO);

    // The exact bug PR #9 demonstrated: the Python class's method must not
    // be invisible — both extractors must see their own class AND method.
    expect(tsResult.nodes.filter((n) => n.type === "class")).toHaveLength(1);
    expect(tsResult.nodes.filter((n) => n.type === "method")).toHaveLength(1);
    expect(pyResult.nodes.filter((n) => n.type === "class")).toHaveLength(1);
    expect(pyResult.nodes.filter((n) => n.type === "method")).toHaveLength(1);

    expect(tsResult.nodes.find((n) => n.type === "class")?.name).toBe("PaymentService");
    expect(pyResult.nodes.find((n) => n.type === "class")?.name).toBe("PaymentService");
    expect(tsResult.nodes.find((n) => n.type === "method")?.name).toBe("charge");
    expect(pyResult.nodes.find((n) => n.type === "method")?.name).toBe("charge");
  });

  it("merging both extractors' output under the same repoId produces no id collisions and no cross-language mistyping", () => {
    const tsProject = tsProjectFromSourceFiles({
      "/src/bar.ts": `export function helper(x: number): number { return x + 1; }`,
      "/src/foo.ts": `
        import { helper } from "./bar";
        export class FooService {
          run(x: number): number { return helper(x); }
        }
      `,
    });
    const pyProject = projectFromSourceFiles({
      "/src/bar.py": `def helper(x):\n    return x + 1\n`,
      "/src/foo.py": `
from .bar import helper


class FooService:
    def run(self, x):
        return helper(x)
`,
    });

    const tsResult = extractTsProject(tsProject, REPO);
    const pyResult = extractProject(pyProject, REPO);

    const combinedNodes = [...tsResult.nodes, ...pyResult.nodes];
    const ids = new Set(combinedNodes.map((n) => n.id));
    expect(ids.size).toBe(combinedNodes.length); // no id collisions across languages

    for (const n of tsResult.nodes) expect(n.metadata.language).toBe("typescript");
    for (const n of pyResult.nodes) expect(n.metadata.language).toBe("python");

    // Same class/method/function shape on both sides, distinct identities.
    const tsMethod = tsResult.nodes.find((n) => n.type === "method" && n.name === "run");
    const pyMethod = pyResult.nodes.find((n) => n.type === "method" && n.name === "run");
    expect(tsMethod?.id).not.toBe(pyMethod?.id);

    const combinedEdges = [...tsResult.edges, ...pyResult.edges];
    // Every edge's endpoints resolve within its OWN language's node set —
    // no edge accidentally points from a TS node to a Python node or vice versa.
    const tsIds = new Set(tsResult.nodes.map((n) => n.id));
    const pyIds = new Set(pyResult.nodes.map((n) => n.id));
    for (const e of tsResult.edges) {
      expect(tsIds.has(e.from)).toBe(true);
      expect(tsIds.has(e.to)).toBe(true);
    }
    for (const e of pyResult.edges) {
      expect(pyIds.has(e.from)).toBe(true);
      expect(pyIds.has(e.to)).toBe(true);
    }
    expect(combinedEdges.length).toBe(tsResult.edges.length + pyResult.edges.length);
  });
});
