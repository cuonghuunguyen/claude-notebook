import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import Parser from "tree-sitter";
// tree-sitter-python ships a Language object (not a class) with no runtime
// type declarations beyond that shape — see tree-sitter-python's bindings/node/index.d.ts.
// eslint-disable-next-line @typescript-eslint/no-var-requires
import PythonLanguage from "tree-sitter-python";

export interface PythonSourceFile {
  filePath: string;
  sourceText: string;
  tree: Parser.Tree;
}

/**
 * Minimal in-memory equivalent of ts-morph's `Project` (packages/structural's
 * extract.ts), scoped to what this extractor needs: a set of parsed files a
 * pure extraction pass can walk. tree-sitter has no built-in project/
 * multi-file abstraction, so this package provides its own.
 */
export class PythonProject {
  private readonly files = new Map<string, PythonSourceFile>();

  addSourceFile(filePath: string, sourceText: string): PythonSourceFile {
    const parser = new Parser();
    parser.setLanguage(PythonLanguage as unknown as Parser.Language);
    const tree = parser.parse(sourceText);
    const file: PythonSourceFile = { filePath, sourceText, tree };
    this.files.set(filePath, file);
    return file;
  }

  getSourceFiles(): PythonSourceFile[] {
    return [...this.files.values()];
  }

  getSourceFile(filePath: string): PythonSourceFile | undefined {
    return this.files.get(filePath);
  }
}

export function projectFromSourceFiles(files: Record<string, string>): PythonProject {
  const project = new PythonProject();
  for (const [path, content] of Object.entries(files)) {
    project.addSourceFile(path, content);
  }
  return project;
}

function walkPythonFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...walkPythonFiles(full));
    } else if (entry.endsWith(".py")) {
      results.push(full);
    }
  }
  return results;
}

export function loadProject(rootDir: string): PythonProject {
  const project = new PythonProject();
  for (const filePath of walkPythonFiles(rootDir)) {
    project.addSourceFile(filePath, readFileSync(filePath, "utf8"));
  }
  return project;
}
