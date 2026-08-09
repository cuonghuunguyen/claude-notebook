import type { Node as CoreNode, Edge as CoreEdge } from "@cognitive-memory/core";
import { nodeId } from "@cognitive-memory/core";
import {
  Node as TsMorphNode,
  Project,
  SyntaxKind,
  type FunctionDeclaration,
  type MethodDeclaration,
  type SourceFile,
} from "ts-morph";
import { shapeFingerprint } from "./shape.js";

export interface ExtractionResult {
  nodes: CoreNode[];
  edges: CoreEdge[];
}

type CallableDecl = FunctionDeclaration | MethodDeclaration;

function declKey(decl: CallableDecl): string {
  return `${decl.getSourceFile().getFilePath()}::${decl.getStart()}`;
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
    metadata: { language: "typescript" },
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

/**
 * Extract structural nodes/edges for every source file currently in the
 * project. Pure function — no I/O beyond what's already loaded into
 * `project`. Persisting to graph-store is a separate step (persist.ts) so
 * this stays unit-testable against an in-memory ts-morph project.
 */
export function extractProject(project: Project, repoId: string): ExtractionResult {
  const nodes: CoreNode[] = [];
  const edges: CoreEdge[] = [];
  const declToNodeId = new Map<string, string>();
  const fileToNodeId = new Map<string, string>();

  const sourceFiles = project.getSourceFiles();

  // Pass 1: files, classes, functions, methods — establishes every id a
  // call/import edge in pass 2 might need to resolve against.
  for (const sourceFile of sourceFiles) {
    const filePath = sourceFile.getFilePath();
    const fileId = nodeId(repoId, filePath);
    fileToNodeId.set(filePath, fileId);
    nodes.push(makeNode(fileId, "file", { path: filePath, name: filePath }));

    for (const fn of sourceFile.getFunctions()) {
      const name = fn.getName();
      if (!name) continue; // anonymous top-level function expressions: skip for MVP
      const id = nodeId(repoId, `${filePath}#function:${shapeFingerprint(fn)}`);
      declToNodeId.set(declKey(fn), id);
      nodes.push(makeNode(id, "function", { name, path: filePath }));
      edges.push(makeEdge(fileId, id, "contains", filePath));
    }

    for (const cls of sourceFile.getClasses()) {
      const className = cls.getName();
      if (!className) continue;
      const classId = nodeId(repoId, `${filePath}#class:${className}`);
      nodes.push(makeNode(classId, "class", { name: className, path: filePath }));
      edges.push(makeEdge(fileId, classId, "contains", filePath));

      for (const method of cls.getMethods()) {
        const methodName = method.getName();
        const methodId = nodeId(
          repoId,
          `${filePath}#class:${className}#method:${shapeFingerprint(method)}`
        );
        declToNodeId.set(declKey(method), methodId);
        nodes.push(
          makeNode(methodId, "method", { name: methodName, path: filePath })
        );
        edges.push(makeEdge(classId, methodId, "contains", filePath));
      }
    }
  }

  // Pass 2: imports (relative, resolved within the project only — MVP scope,
  // package imports from node_modules are not modeled yet) and calls
  // (resolved via the language service, so this only fires for calls the
  // type checker can actually bind to a declaration we extracted above).
  for (const sourceFile of sourceFiles) {
    const filePath = sourceFile.getFilePath();
    const fileId = fileToNodeId.get(filePath);
    if (!fileId) continue;

    for (const imp of sourceFile.getImportDeclarations()) {
      const target = imp.getModuleSpecifierSourceFile();
      if (!target) continue; // unresolved or non-relative (node_modules) import
      const targetId = fileToNodeId.get(target.getFilePath());
      if (!targetId) continue;
      edges.push(makeEdge(fileId, targetId, "imports", filePath));
    }

    const callables: CallableDecl[] = [
      ...sourceFile.getFunctions(),
      ...sourceFile.getClasses().flatMap((c) => c.getMethods()),
    ];

    for (const callable of callables) {
      const callerId = declToNodeId.get(declKey(callable));
      if (!callerId) continue;

      for (const call of callable.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const callee = call.getExpression();
        const nameNode = TsMorphNode.isPropertyAccessExpression(callee)
          ? callee.getNameNode()
          : TsMorphNode.isIdentifier(callee)
            ? callee
            : undefined;
        if (!nameNode) continue;

        for (const def of nameNode.getDefinitionNodes()) {
          if (
            !TsMorphNode.isFunctionDeclaration(def) &&
            !TsMorphNode.isMethodDeclaration(def)
          ) {
            continue;
          }
          const calleeId = declToNodeId.get(declKey(def));
          if (calleeId) edges.push(makeEdge(callerId, calleeId, "calls", filePath));
        }
      }
    }
  }

  return { nodes, edges };
}

export function loadProject(rootDir: string, tsConfigFilePath?: string): Project {
  return new Project(
    tsConfigFilePath ? { tsConfigFilePath } : { compilerOptions: { rootDir } }
  );
}

export function projectFromSourceFiles(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [path, content] of Object.entries(files)) {
    project.createSourceFile(path, content);
  }
  return project;
}

export type { SourceFile };
