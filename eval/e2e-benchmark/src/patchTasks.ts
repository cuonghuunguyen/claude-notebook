/**
 * Layer 4: real code-change tasks, not question answering.
 *
 * Each task seeds a *behavioural regression* into a pristine copy of the
 * lodash-es clone, hands the agent only the user-visible symptom, and grades
 * the result by executing the patched module. That makes grading deterministic
 * in a way "did the answer mention the right file" never is: either
 * `_.sortBy` is stable again or it isn't.
 *
 * The seeded edits are all one-line semantic breaks in an internal file whose
 * name never appears in the symptom the agent is given, so finding it is a
 * genuine multi-hop navigation problem — exactly the kind the memory layer
 * claims to help with:
 *
 *   sortBy    -> _baseOrderBy -> _baseSortBy   -> _compareMultiple
 *   _.get     -> _baseGet     -> _castPath     -> _stringToPath
 *   isEqual   -> _baseIsEqual -> _baseIsEqualDeep -> _equalObjects
 *
 * Note the graph is ingested from the *clean* checkout, so during these runs
 * memory is very slightly stale relative to the working tree (it knows the
 * structure, not the seeded bug). That is realistic — a real memory layer is
 * always a little behind the working copy — and it is stated in the report.
 */

export interface PatchTask {
  id: string;
  /** The symptom a developer would actually report — no file names in it. */
  symptom: string;
  /** File the seeded regression lives in (also the ground-truth fix site). */
  brokenFile: string;
  /** Exact substring to replace in `brokenFile` (must be unique in it). */
  find: string;
  /** What it becomes — the seeded bug. */
  replace: string;
  /** Files a correct fix is expected to touch. */
  expectedFiles: string[];
  /**
   * ESM verification module, written into the working copy and executed with
   * node. Must throw on failure and print nothing on success. Imports resolve
   * against the copy, so it tests the agent's actual patch.
   */
  verify: string;
}

export const PATCH_TASKS: PatchTask[] = [
  {
    id: "fix-sort-stability",
    symptom:
      "sortBy is no longer stable: sorting a list of objects by a key that ties for several " +
      "elements no longer preserves their original relative order. Find the cause and fix it.",
    brokenFile: "_compareMultiple.js",
    // NOT `return 0`: V8's Array#sort has been stable since ES2019, so
    // neutralising the tie-break would leave behaviour unchanged and the task
    // would grade as "already passing". Inverting it is a real regression.
    find: "return object.index - other.index;",
    replace: "return other.index - object.index;",
    expectedFiles: ["_compareMultiple.js"],
    verify: `
import sortBy from './sortBy.js';
const input = [
  { k: 1, id: 'a' }, { k: 0, id: 'b' }, { k: 1, id: 'c' },
  { k: 0, id: 'd' }, { k: 1, id: 'e' }, { k: 0, id: 'f' },
];
const got = sortBy(input, 'k').map((x) => x.id).join('');
if (got !== 'bdface') throw new Error('sortBy is not stable: expected bdface, got ' + got);
`,
  },
  {
    id: "fix-bracket-path",
    symptom:
      "Reading a nested value with a bracketed path string such as _.get(obj, 'a[0].b') now " +
      "returns undefined, while the dotted form _.get(obj, 'a.0.b') still works. Find the cause and fix it.",
    brokenFile: "_stringToPath.js",
    // Drops the bracket regex's captured index group, so 'a[0].b' yields the
    // key '[0]' instead of '0' while the dotted form is untouched — exactly
    // the asymmetry the symptom describes.
    find: "(number || match)",
    replace: "match",
    expectedFiles: ["_stringToPath.js"],
    verify: `
import get from './get.js';
const obj = { a: [{ b: 42 }], 'x y': { z: 1 } };
const bracket = get(obj, 'a[0].b');
if (bracket !== 42) throw new Error('bracket path broken: expected 42, got ' + bracket);
const dotted = get(obj, 'a.0.b');
if (dotted !== 42) throw new Error('dotted path broken: expected 42, got ' + dotted);
if (get(obj, ['x y', 'z']) !== 1) throw new Error('array path broken');
`,
  },
  {
    id: "fix-key-order-equality",
    symptom:
      "isEqual now reports two plain objects that hold the same keys and values as different " +
      "when the keys were inserted in a different order. Find the cause and fix it.",
    brokenFile: "_equalObjects.js",
    // Compares the two objects' values *positionally* instead of by key.
    // Reversing the key list would not have worked: both sides are looked up
    // by the same key, so order alone doesn't affect the result.
    find: "var objValue = object[key],\n        othValue = other[key];",
    replace: "var objValue = object[key],\n        othValue = other[othProps[index]];",
    expectedFiles: ["_equalObjects.js"],
    verify: `
import isEqual from './isEqual.js';
if (!isEqual({ a: 1, b: 2, c: 3 }, { c: 3, b: 2, a: 1 })) {
  throw new Error('key-order-insensitive equality broken');
}
if (isEqual({ a: 1, b: 2 }, { a: 1, b: 3 })) throw new Error('unequal objects reported equal');
if (!isEqual([1, [2, 3]], [1, [2, 3]])) throw new Error('array equality broken');
`,
  },
];

/**
 * Layer 5: the follow-up tasks. Each is a *different* regression in the same
 * neighbourhood of the import graph as its chain's first task — near enough
 * that a lesson learned while fixing the first one is genuinely applicable,
 * far enough that the answer isn't the same file.
 *
 *   sorting chain: _compareMultiple.js  (session 1) -> _baseSortBy.js (session 2)
 *   path chain:    _stringToPath.js     (session 1) -> _castPath.js   (session 2)
 */
const FOLLOW_UP_TASKS: PatchTask[] = [
  {
    id: "fix-sort-not-applied",
    symptom:
      "sortBy returns the collection in its original order — it isn't sorting at all, whatever " +
      "key or iteratee is passed. Find the cause and fix it.",
    brokenFile: "_baseSortBy.js",
    // Drops the comparator, so the criteria objects fall back to default
    // string coercion ("[object Object]" for all of them) and the sort becomes
    // a no-op. Deliberately NOT a tweak inside _compareAscending: that
    // comparator is symmetric, so disabling one direction leaves the other
    // producing the same order and the seed would not be live.
    find: "array.sort(comparer);",
    replace: "array.sort();",
    expectedFiles: ["_baseSortBy.js"],
    verify: `
import sortBy from './sortBy.js';
const byKey = sortBy([{ n: 3 }, { n: 1 }, { n: 2 }], 'n').map((x) => x.n).join(',');
if (byKey !== '1,2,3') throw new Error('sortBy(key) did not sort: ' + byKey);
const plain = sortBy([3, 1, 2]).join(',');
if (plain !== '1,2,3') throw new Error('sortBy did not sort: ' + plain);
`,
  },
  {
    id: "fix-literal-dotted-key",
    symptom:
      "Reading a property whose name literally contains a dot, e.g. _.get(obj, 'a.b') on an " +
      "object that really has a key called 'a.b', now returns undefined instead of the value. " +
      "Find the cause and fix it.",
    brokenFile: "_castPath.js",
    find: "return isKey(value, object) ? [value] : stringToPath(toString(value));",
    replace: "return stringToPath(toString(value));",
    expectedFiles: ["_castPath.js"],
    verify: `
import get from './get.js';
if (get({ 'a.b': 1 }, 'a.b') !== 1) throw new Error('literal dotted key lookup broken');
if (get({ a: { b: 2 } }, 'a.b') !== 2) throw new Error('nested dotted path broken');
if (get({ a: [{ b: 3 }] }, 'a[0].b') !== 3) throw new Error('bracket path broken');
`,
  },
];

export interface Chain {
  id: string;
  /** What makes the two tasks neighbours — quoted in the report. */
  relation: string;
  first: PatchTask;
  second: PatchTask;
}

const byId = (id: string): PatchTask => {
  const task = [...PATCH_TASKS, ...FOLLOW_UP_TASKS].find((t) => t.id === id);
  if (!task) throw new Error(`unknown patch task ${id}`);
  return task;
};

export const CHAINS: Chain[] = [
  {
    id: "sorting",
    relation:
      "_baseOrderBy.js calls _baseSortBy.js with _compareMultiple.js as its comparator — the " +
      "fix sites are one hop apart in the call graph, both reached from sortBy",
    first: byId("fix-sort-stability"),
    second: byId("fix-sort-not-applied"),
  },
  {
    id: "paths",
    relation:
      "_castPath.js imports _stringToPath.js; both are reached from _.get through _baseGet",
    first: byId("fix-bracket-path"),
    second: byId("fix-literal-dotted-key"),
  },
];

export { FOLLOW_UP_TASKS };
