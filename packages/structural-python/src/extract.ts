import type { Node as CoreNode, Edge as CoreEdge } from "@cognitive-memory/core";
import { nodeId } from "@cognitive-memory/core";
import { normalize } from "node:path";
import type { SyntaxNode } from "tree-sitter";
import {
  importedName,
  parseRelativeImport,
  resolveAbsoluteModule,
  resolveModule,
  resolveRelativeModule,
} from "./imports.js";
import { PythonProject, loadProject, projectFromSourceFiles } from "./project.js";
import { shapeFingerprint } from "./shape.js";

export interface ExtractionResult {
  nodes: CoreNode[];
  edges: CoreEdge[];
}

function now(): string {
  return new Date().toISOString();
}

function makeNode(
  id: string,
  type: CoreNode["type"],
  opts: { name?: string; path?: string }
): CoreNode {
  const t = now();
  return {
    id,
    type,
    name: opts.name,
    path: opts.path,
    metadata: { language: "python" },
    provenance: [
      {
        sourceType: "source_code",
        sourceId: opts.path ?? id,
        confidence: 1,
        observedAt: t,
      },
    ],
    status: "active",
    createdAt: t,
    updatedAt: t,
  };
}

function makeEdge(
  from: string,
  to: string,
  relation: CoreEdge["relation"],
  sourceId: string
): CoreEdge {
  const t = now();
  return {
    id: `${from}:${relation}:${to}`,
    from,
    to,
    relation,
    confidence: 1,
    weight: 0.5,
    provenance: [
      { sourceType: "source_code", sourceId, confidence: 1, observedAt: t },
    ],
    status: "active",
    createdAt: t,
    updatedAt: t,
  };
}

/** Unwrap a `decorated_definition` to the function/class it decorates; pass through either directly. */
function unwrapDefinition(node: SyntaxNode): SyntaxNode | undefined {
  if (node.type === "function_definition" || node.type === "class_definition") return node;
  if (node.type === "decorated_definition") {
    const inner = node.childForFieldName("definition");
    if (inner && (inner.type === "function_definition" || inner.type === "class_definition")) {
      return inner;
    }
  }
  return undefined;
}

function topLevelDefinitions(moduleRoot: SyntaxNode): SyntaxNode[] {
  const defs: SyntaxNode[] = [];
  for (const child of moduleRoot.namedChildren) {
    const def = unwrapDefinition(child);
    if (def) defs.push(def);
  }
  return defs;
}

function methodDefinitions(classDef: SyntaxNode): SyntaxNode[] {
  const body = classDef.childForFieldName("body");
  const defs: SyntaxNode[] = [];
  for (const stmt of body?.namedChildren ?? []) {
    const def = unwrapDefinition(stmt);
    if (def?.type === "function_definition") defs.push(def);
  }
  return defs;
}

function declKey(filePath: string, decl: SyntaxNode): string {
  return `${filePath}::${decl.startIndex}`;
}

/** All `call` expressions anywhere within `decl` (its whole subtree — parameters, nested closures, everything), matching ts-morph's getDescendantsOfKind scope in packages/structural. */
function findCalls(decl: SyntaxNode): SyntaxNode[] {
  const calls: SyntaxNode[] = [];
  const stack = [...decl.namedChildren];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (node.type === "call") calls.push(node);
    stack.push(...node.namedChildren);
  }
  return calls;
}

interface Callable {
  decl: SyntaxNode;
  callerId: string;
  enclosingClass?: string;
}

/**
 * Extract structural nodes/edges for every Python file currently in
 * `project`. Pure function, no I/O — persisting is a separate step
 * (persist.ts), same split as packages/structural's extract.ts.
 *
 * Node/edge identity, provenance, and incremental-update contract mirror
 * packages/structural exactly (spec.md §21); only the resolution mechanics
 * differ because tree-sitter has no type checker: calls resolve by name
 * against same-file top-level functions, imported names, and (for
 * `self.foo()`/`cls.foo()`) the enclosing class's methods — a plain
 * `obj.foo()` where `obj`'s type isn't known is left unresolved, the same
 * MVP posture ts-morph's extractor takes for calls its checker can't bind.
 */
export function extractProject(project: PythonProject, repoId: string): ExtractionResult {
  const nodes: CoreNode[] = [];
  const edges: CoreEdge[] = [];
  const declToNodeId = new Map<string, string>();
  const fileToNodeId = new Map<string, string>();
  const moduleFunctionsByFile = new Map<string, Map<string, string>>();
  const classMethodsByFile = new Map<string, Map<string, Map<string, string>>>();

  const sourceFiles = project.getSourceFiles();
  const knownPaths = new Set(sourceFiles.map((f) => normalize(f.filePath)));

  // Pass 1: files, classes, functions, methods — establishes every id a
  // call/import edge in pass 2 might need to resolve against.
  for (const file of sourceFiles) {
    const filePath = file.filePath;
    const fileId = nodeId(repoId, filePath);
    fileToNodeId.set(filePath, fileId);
    nodes.push(makeNode(fileId, "file", { path: filePath, name: filePath }));

    const fnsByName = new Map<string, string>();
    moduleFunctionsByFile.set(filePath, fnsByName);
    const classesInFile = new Map<string, Map<string, string>>();
    classMethodsByFile.set(filePath, classesInFile);

    for (const def of topLevelDefinitions(file.tree.rootNode)) {
      if (def.type === "function_definition") {
        const name = def.childForFieldName("name")?.text;
        if (!name) continue;
        const id = nodeId(repoId, `${filePath}#function:${shapeFingerprint(def)}`);
        declToNodeId.set(declKey(filePath, def), id);
        fnsByName.set(name, id);
        nodes.push(makeNode(id, "function", { name, path: filePath }));
        edges.push(makeEdge(fileId, id, "contains", filePath));
      } else {
        const className = def.childForFieldName("name")?.text;
        if (!className) continue;
        const classId = nodeId(repoId, `${filePath}#class:${className}`);
        nodes.push(makeNode(classId, "class", { name: className, path: filePath }));
        edges.push(makeEdge(fileId, classId, "contains", filePath));

        const methodsByName = new Map<string, string>();
        classesInFile.set(className, methodsByName);

        for (const methodDef of methodDefinitions(def)) {
          const methodName = methodDef.childForFieldName("name")?.text;
          if (!methodName) continue;
          const methodId = nodeId(
            repoId,
            `${filePath}#class:${className}#method:${shapeFingerprint(methodDef)}`
          );
          declToNodeId.set(declKey(filePath, methodDef), methodId);
          methodsByName.set(methodName, methodId);
          nodes.push(makeNode(methodId, "method", { name: methodName, path: filePath }));
          edges.push(makeEdge(classId, methodId, "contains", filePath));
        }
      }
    }
  }

  // Pass 2: imports (resolved within the project only — MVP scope, same as
  // packages/structural) and calls (resolved by name, see the doc comment above).
  for (const file of sourceFiles) {
    const filePath = file.filePath;
    const fileId = fileToNodeId.get(filePath);
    if (!fileId) continue;

    const importedNames = new Map<string, string>(); // local binding -> resolved callee node id
    const classesInFile = classMethodsByFile.get(filePath) ?? new Map();
    const fnsByName = moduleFunctionsByFile.get(filePath) ?? new Map();

    for (const stmt of file.tree.rootNode.namedChildren) {
      if (stmt.type === "import_from_statement") {
        const moduleNode = stmt.childForFieldName("module_name");
        if (!moduleNode) continue;

        // `from . import bar` / `from .. import bar`: no dotted module path,
        // so each imported name is itself a submodule to resolve individually
        // (not a symbol looked up within one shared target module).
        if (moduleNode.type === "relative_import" && !parseRelativeImport(moduleNode).dottedName) {
          const { dots } = parseRelativeImport(moduleNode);
          for (const nameField of stmt.childrenForFieldName("name")) {
            const imported = importedName(nameField);
            if (!imported) continue;
            const subFile = resolveRelativeModule(filePath, dots, [imported.originalName], knownPaths);
            if (!subFile) continue;
            const subId = fileToNodeId.get(subFile);
            if (subId) edges.push(makeEdge(fileId, subId, "imports", filePath));
            // The bound local name refers to the whole submodule, not a
            // function within it — `bar.helper(...)`-style attribute calls
            // stay unresolved, same MVP posture as any other obj.method() call.
          }
          continue;
        }

        const targetFile = resolveModule(filePath, moduleNode, knownPaths);
        if (!targetFile) continue;

        const targetId = fileToNodeId.get(targetFile);
        if (targetId) edges.push(makeEdge(fileId, targetId, "imports", filePath));

        const targetFns = moduleFunctionsByFile.get(targetFile);
        for (const nameField of stmt.childrenForFieldName("name")) {
          const imported = importedName(nameField);
          if (!imported) continue;
          const fnId = targetFns?.get(imported.originalName);
          if (fnId) importedNames.set(imported.localName, fnId);
        }
      } else if (stmt.type === "import_statement") {
        for (const nameField of stmt.childrenForFieldName("name")) {
          const imported = importedName(nameField);
          if (!imported) continue;
          const targetFile = resolveAbsoluteModule(imported.originalName.split("."), knownPaths);
          if (!targetFile) continue;
          const targetId = fileToNodeId.get(targetFile);
          if (targetId) edges.push(makeEdge(fileId, targetId, "imports", filePath));
        }
      }
    }

    const callables: Callable[] = [];
    for (const def of topLevelDefinitions(file.tree.rootNode)) {
      if (def.type === "function_definition") {
        const callerId = declToNodeId.get(declKey(filePath, def));
        if (callerId) callables.push({ decl: def, callerId });
      } else {
        const className = def.childForFieldName("name")?.text;
        for (const methodDef of methodDefinitions(def)) {
          const callerId = declToNodeId.get(declKey(filePath, methodDef));
          if (callerId) callables.push({ decl: methodDef, callerId, enclosingClass: className });
        }
      }
    }

    for (const { decl, callerId, enclosingClass } of callables) {
      for (const call of findCalls(decl)) {
        const fn = call.childForFieldName("function");
        if (!fn) continue;

        if (fn.type === "identifier") {
          const calleeId = fnsByName.get(fn.text) ?? importedNames.get(fn.text);
          if (calleeId) edges.push(makeEdge(callerId, calleeId, "calls", filePath));
        } else if (fn.type === "attribute") {
          const object = fn.childForFieldName("object");
          const attr = fn.childForFieldName("attribute")?.text;
          if (!attr || !object || !enclosingClass) continue;
          if (object.type === "identifier" && (object.text === "self" || object.text === "cls")) {
            const calleeId = classesInFile.get(enclosingClass)?.get(attr);
            if (calleeId) edges.push(makeEdge(callerId, calleeId, "calls", filePath));
          }
        }
      }
    }
  }

  return { nodes, edges };
}

export { loadProject, PythonProject, projectFromSourceFiles };
export type { PythonSourceFile } from "./project.js";
