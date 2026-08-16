/**
 * Target: lodash-es (the `es` branch of github.com/lodash/lodash) — 644 tiny
 * plain-JavaScript ESM modules, one exported function each, wired together by
 * a dense relative-import graph.
 *
 * This is the structural opposite of the zod target (32 huge TypeScript files,
 * sparse imports), which is the point: it tests whether the zod numbers were a
 * property of the system or a property of zod.
 *
 * Ground truth was labeled by reading the lodash source directly — every
 * expected file was opened and verified to contain the implementation the
 * question asks about (e.g. the stable-sort tie-break really is
 * `object.index - other.index` in _compareMultiple.js). Paths are suffixes,
 * matched with endsWith().
 *
 * The question set is deliberately split down the middle:
 *
 *   - `hops: "single"` — the question names the function, and lodash's
 *     one-function-per-file layout means the filename contains the answer.
 *     A keyword grep should be near-perfect here.
 *   - `hops: "multi"`  — the question describes only a *behaviour*, and the
 *     code implementing it sits behind two or three indirections in
 *     underscore-prefixed internal files whose names never appear in the
 *     question ("how does uniq stay fast on big arrays" -> _baseUniq ->
 *     _SetCache). This is the regime graph memory is supposed to win.
 *
 * Reporting the two groups separately is what makes the result diagnostic
 * rather than a single averaged number that hides where the value is.
 */
import fs from "node:fs";
import path from "node:path";
import type { BenchTarget, BenchmarkTask } from "./types.js";

const TASKS: BenchmarkTask[] = [
  {
    id: "debounce-maxwait",
    question: "How does the maxWait option of debounce work and where is the trailing edge invocation decided?",
    expectedFiles: ["debounce.js"],
    expectedSymbols: ["debounce", "maxWait", "trailingEdge"],
    hops: "single",
  },
  {
    id: "template-compile",
    question: "Where does template compile a template string into a JavaScript function?",
    expectedFiles: ["template.js"],
    expectedSymbols: ["template", "sourceURL"],
    hops: "single",
  },
  {
    id: "curry-flags",
    question: "Where is curry implemented and how does it pass the currying flag to the wrapper factory?",
    expectedFiles: ["curry.js", "_createWrap.js"],
    expectedSymbols: ["curry", "createWrap", "WRAP_CURRY_FLAG"],
    hops: "single",
  },
  {
    id: "memoize-cache",
    question: "Which cache does memoize use by default and how does that cache choose between its backing stores?",
    expectedFiles: ["memoize.js", "_MapCache.js"],
    expectedSymbols: ["MapCache", "getMapData"],
    hops: "single",
  },
  {
    id: "typed-array-check",
    question: "How does isTypedArray detect typed arrays, and what does it fall back to outside Node?",
    expectedFiles: ["isTypedArray.js", "_baseIsTypedArray.js"],
    expectedSymbols: ["baseIsTypedArray", "nodeUtil"],
    hops: "single",
  },
  {
    id: "sort-stable",
    question: "When two elements compare equal during a sort, what keeps their original relative order?",
    expectedFiles: ["_compareMultiple.js", "_baseSortBy.js"],
    expectedSymbols: ["compareMultiple", "baseSortBy", "index"],
    hops: "multi",
  },
  {
    id: "uniq-large",
    question: "What stops deduplicating a very large array from degrading into a quadratic scan?",
    expectedFiles: ["_baseUniq.js", "_SetCache.js"],
    expectedSymbols: ["baseUniq", "SetCache", "LARGE_ARRAY_SIZE"],
    hops: "multi",
  },
  {
    id: "deep-equal",
    question: "Which code decides that two plain objects holding the same keys in a different order are equal?",
    expectedFiles: ["_equalObjects.js", "_baseIsEqualDeep.js"],
    expectedSymbols: ["equalObjects", "baseIsEqualDeep"],
    hops: "multi",
  },
  {
    id: "clone-cycles",
    question: "How does deep cloning avoid infinite recursion when a value contains a circular reference?",
    expectedFiles: ["_baseClone.js", "_Stack.js"],
    expectedSymbols: ["baseClone", "Stack"],
    hops: "multi",
  },
  {
    id: "path-parse",
    question: "How is a property path written as a string like 'a[0].b.c' turned into the keys used to walk an object?",
    expectedFiles: ["_stringToPath.js", "_castPath.js"],
    expectedSymbols: ["stringToPath", "castPath", "memoizeCapped"],
    hops: "multi",
  },
  {
    id: "iteratee-shorthand",
    question: "When a collection method is given a property name string or a partial object instead of a function, what converts it into a callback?",
    expectedFiles: ["_baseIteratee.js", "_baseMatches.js"],
    expectedSymbols: ["baseIteratee", "baseMatches", "baseMatchesProperty"],
    hops: "multi",
  },
  {
    id: "lazy-chain",
    question: "When a chained sequence is finally unwrapped, what actually applies the queued operations in one pass?",
    expectedFiles: ["_lazyValue.js", "_LazyWrapper.js"],
    expectedSymbols: ["lazyValue", "LazyWrapper"],
    hops: "multi",
  },
];

export const lodashTarget: BenchTarget = {
  key: "lodash",
  repoId: "lodash-es-benchmark",
  origin: "https://github.com/lodash/lodash (branch: es)",
  dirEnv: "LODASH_DIR",
  agentPathHint: "the exact source file name(s) in this repo (e.g. _baseUniq.js)",
  /**
   * Plain JS: without allowJs the TypeScript checker has no symbol for a
   * `function` declaration in a .js file and the extractor's shapeFingerprint
   * -> getReturnType() call throws. See the report's finding #1.
   */
  compilerOptions: { allowJs: true },
  root: (cloneDir) => cloneDir,
  /** The es branch is flat: every module is a .js file at the repo root. */
  sourceGlobs: (root) => [`${root}/*.js`],
  indexedFiles: (root) =>
    fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".js"))
      .map((e) => path.join(root, e.name)),
  /**
   * No synthetic seeds, unlike the zod target: the episodic layer is measured
   * here with experiences a real agent session actually produced (see
   * sessionChain.ts), so seeding invented ones would contaminate that.
   */
  agentTaskIds: [
    "debounce-maxwait",
    "template-compile",
    "curry-flags",
    "sort-stable",
    "uniq-large",
    "deep-equal",
  ],
  tasks: TASKS,
};
