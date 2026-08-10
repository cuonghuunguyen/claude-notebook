import { dirname, join, normalize, sep } from "node:path";
import type { SyntaxNode } from "tree-sitter";

export interface RelativeImport {
  dots: number;
  /** The dotted module path after the dots, e.g. "bar" in `from .bar import x`. Absent for `from . import bar`, where each imported name is itself a submodule. */
  dottedName?: string;
}

/** Parse a `relative_import` node's leading-dots count and (if present) trailing dotted module path. */
export function parseRelativeImport(node: SyntaxNode): RelativeImport {
  let dots = 0;
  let dottedName: string | undefined;
  for (const child of node.namedChildren) {
    if (child.type === "import_prefix") dots += child.text.length;
    if (child.type === "dotted_name") dottedName = child.text;
  }
  return { dots, dottedName };
}

/**
 * Resolve a Python `import_from_statement`'s `module_name` field (either a
 * `relative_import` — `from .foo import bar` — or a plain `dotted_name` —
 * `from foo import bar`) to a known project file path. Returns `undefined`
 * for a bare `from . import bar` relative import with no dotted module path
 * — there, each imported name is itself a submodule to resolve individually
 * via `resolveRelativeModule`, not a single shared target module.
 *
 * MVP scope, mirroring packages/structural's ts-morph extractor: only
 * modules that resolve to a file already in `knownPaths` produce an edge;
 * anything else (a real installed package, an unresolvable path) is treated
 * like ts-morph's "unresolved or non-relative (node_modules) import" case
 * and silently skipped.
 */
export function resolveModule(
  currentFilePath: string,
  moduleNameNode: SyntaxNode,
  knownPaths: ReadonlySet<string>
): string | undefined {
  if (moduleNameNode.type === "relative_import") {
    const { dots, dottedName } = parseRelativeImport(moduleNameNode);
    if (!dottedName) return undefined;
    return resolveRelativeModule(currentFilePath, dots, dottedName.split("."), knownPaths);
  }
  // Plain dotted_name with no leading dots: could be an absolute intra-project
  // module (matched by suffix) or a real third-party package (unresolved).
  return resolveAbsoluteModule(moduleNameNode.text.split("."), knownPaths);
}

function candidatePaths(baseDir: string, moduleParts: string[]): string[] {
  if (moduleParts.length === 0) return [];
  const joined = join(baseDir, ...moduleParts);
  return [`${joined}.py`, join(joined, "__init__.py")];
}

/** Resolve a dotted module path relative to `dots` levels of `currentFilePath`'s package — one dot is the current file's own directory, each additional dot climbs one more level. */
export function resolveRelativeModule(
  currentFilePath: string,
  dots: number,
  moduleParts: string[],
  knownPaths: ReadonlySet<string>
): string | undefined {
  let baseDir = dirname(currentFilePath);
  for (let i = 1; i < dots; i++) baseDir = dirname(baseDir);

  for (const candidate of candidatePaths(baseDir, moduleParts)) {
    const normalized = normalize(candidate);
    if (knownPaths.has(normalized)) return normalized;
  }
  return undefined;
}

/** Resolve a module referenced without leading dots by matching a path suffix against known project files. */
export function resolveAbsoluteModule(
  moduleParts: string[],
  knownPaths: ReadonlySet<string>
): string | undefined {
  if (moduleParts.length === 0) return undefined;
  const suffix = moduleParts.join(sep);
  for (const path of knownPaths) {
    const normalized = normalize(path);
    if (
      normalized === `${suffix}.py` ||
      normalized.endsWith(`${sep}${suffix}.py`) ||
      normalized.endsWith(`${sep}${suffix}${sep}__init__.py`)
    ) {
      return path;
    }
  }
  return undefined;
}

export interface ImportedName {
  /** The name as it's referenced in the imported module (what to look up there). */
  originalName: string;
  /** The name as it's bound in the importing file (what a call expression here would use). */
  localName: string;
}

/**
 * Read one `name` field entry from an `import_statement`/`import_from_statement`
 * — either a plain `dotted_name` or an `aliased_import` (`import X as Y` /
 * `from mod import X as Y`), where the local binding is the alias, not the
 * original name.
 */
export function importedName(nameField: SyntaxNode): ImportedName | undefined {
  if (nameField.type === "aliased_import") {
    const originalName = nameField.childForFieldName("name")?.text;
    const localName = nameField.childForFieldName("alias")?.text;
    if (!originalName || !localName) return undefined;
    return { originalName, localName };
  }
  const name = nameField.text;
  if (!name) return undefined;
  return { originalName: name, localName: name };
}
