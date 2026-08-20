/**
 * Questions whose ground truth spans **two** commits (ROADMAP.md M14).
 *
 * The why-spike asked questions one commit could answer, which is why a single
 * by-meaning hit was enough there. This set is the opposite: each question has
 * two *slots*, and an answer built from either commit alone is incomplete —
 * "was X implemented?" and "does it still apply?" are different commits.
 *
 * A slot is a set of shas, not one sha, because a change can appear twice in a
 * history (zod's base64 fix landed once by accident on main and once through
 * its PR, byte-identical). Any member of a slot fills it.
 *
 * **How these were chosen, and the bias that introduces.** The two-commit
 * stories were found by scanning commit *bodies* for cross-reference language
 * ("regression", "supersedes", "reverts", "follow-up") over the same 400-commit
 * window — a discovery path independent of the miner's rules, but not disjoint
 * from them: a commit that says "this reverts …" is findable both ways. So the
 * set over-represents pairs the miner links (8 of 10 here), and that skew
 * favours the link arm. `linkedByMiner` is recorded per question and the probe
 * reports both subsets separately, so the skew is visible rather than baked
 * into one number. Two questions were kept precisely *because* the miner does
 * not link their gold pair.
 *
 * `mustMention` groups are drawn from BOTH commits, so an answer that knows
 * only one of them cannot score 1.0.
 */
export interface GoldSlot {
  /** What this half of the answer is, for the report. */
  name: string;
  /** Any one of these short shas fills the slot. */
  shas: string[];
}

export interface LinkQuestion {
  id: string;
  question: string;
  gold: [GoldSlot, GoldSlot];
  /**
   * Whether the miner emits an edge between the two slots. Recorded here as an
   * expectation *about the corpus*, and re-derived at probe time — a mismatch
   * means the miner changed and this file is stale.
   */
  linkedByMiner: boolean;
  mustMention: string[][];
}

export const QUESTIONS: LinkQuestion[] = [
  {
    id: "base64-whitespace",
    question:
      "Rejecting whitespace in z.base64() to close the atob bypass: was it ever implemented in this repository, and is it in effect today? Explain what happened.",
    gold: [
      { name: "the fix", shas: ["91a7d0d1", "584b1089"] },
      { name: "the revert", shas: ["23edf484"] },
    ],
    linkedByMiner: true,
    mustMention: [
      ["atob"],
      ["whitespace"],
      ["revert"],
      ["accident", "mistake", "unintention", "tracking", "directly to main", "branch"],
    ],
  },
  // A second revert question was drafted here (the reverted en-locale
  // instanceof work, 3c1f32bd -> bf6d99ed) and removed: `bf6d99ed`'s whole
  // body is "This reverts commit 3c1f32bd…", which is below `isExplanatory`'s
  // bar, so capture never records it and NO arm can retrieve it. The edge is
  // mined and correct; there is simply nothing on the other end to put in a
  // context. That is a result, not an inconvenience — see the revert-edge
  // coverage figure in `results/coverage.json` and the BENCHMARKS.md row.
  {
    id: "internals-prototype-move",
    question:
      "Lazily-derived _zod internals (values, pattern, optin, optout) were moved onto a per-constructor prototype. What did that buy, and what broke as a result?",
    gold: [
      { name: "the move", shas: ["b1077f05"] },
      { name: "the regressions it caused", shas: ["9f0a3d81"] },
    ],
    linkedByMiner: true,
    mustMention: [
      ["prototype"],
      ["memory", "kb", "shrink", "smaller", "faster"],
      ["regress", "broke", "restore"],
      ["derived constructor", "override", "recursi", "memoiz"],
    ],
  },
  {
    id: "proto-strict-ordering",
    question:
      "Under .strict(), why is the object parser's __proto__ branch ordered relative to the keySet check the way it is, and what earlier change forced that ordering?",
    gold: [
      { name: "the __proto__ own-property fix", shas: ["ead9fcb3"] },
      { name: "the .strict() regression fix", shas: ["e7029aa4"] },
    ],
    linkedByMiner: true,
    mustMention: [
      ["__proto__"],
      ["strict"],
      ["own property", "own key", "setter", "inherited"],
      ["unrecognized", "reject", "regress"],
    ],
  },
  {
    id: "lazy-internals-seal",
    question:
      "The lazy internals once carried a $constructor-level seal and a per-key WeakSet. Why were they introduced, and why are they no longer there?",
    gold: [
      { name: "the restore that added them", shas: ["9f0a3d81"] },
      { name: "the perf change that dropped them", shas: ["c9ec89e0"] },
    ],
    linkedByMiner: true,
    mustMention: [["seal"], ["weakset"], ["recursi"], ["cost", "perf", "overhead", "allocat", "drop"]],
  },
  {
    id: "tuple-input-optin",
    question:
      "In input mode, why does the JSON Schema tuple processor resolve minItems through the same static helper objectProcessor uses for its `required` list, rather than reading the runtime optin flag?",
    gold: [
      { name: "the object-side change", shas: ["78b523f0"] },
      { name: "the tuple-side follow-up", shas: ["eb4682c9"] },
    ],
    linkedByMiner: true,
    mustMention: [["optin"], ["input"], ["minitems"], ["preprocess", "transform"]],
  },
  {
    id: "mac-locale-gap",
    question:
      "Why were dozens of locales missing a `mac` error message, and when did that gap open?",
    gold: [
      { name: "the feature that opened the gap", shas: ["3d93a7d5"] },
      { name: "the backfill that closed it", shas: ["7378e7cd"] },
    ],
    linkedByMiner: true,
    mustMention: [["mac"], ["locale"], ["backfill", "missing", "gap", "parity"], ["5440"]],
  },
  {
    id: "writeable-shape",
    question:
      "Why do z.strictObject/z.looseObject and zod/mini's object constructors wrap their shape in util.Writeable, and how did that end up applied in two separate steps?",
    gold: [
      { name: "the classic strict/loose fix", shas: ["757f0b0f"] },
      { name: "the mini + extend/partial extension", shas: ["fa4a3740"] },
    ],
    linkedByMiner: true,
    mustMention: [["writeable"], ["readonly"], ["shape"], ["mini"]],
  },
  {
    id: "unrepresentable-escape",
    question:
      "Representing one unrepresentable type in toJSONSchema used to mean setting unrepresentable: 'any' and losing the error for every other type. What two changes fixed that, and in what order?",
    gold: [
      { name: "the override reordering", shas: ["fd074106"] },
      { name: "the function form", shas: ["bd6619c0"] },
    ],
    linkedByMiner: true,
    mustMention: [
      ["unrepresentable"],
      ["override"],
      ["function", "callback"],
      ["order", "before", "first", "then"],
    ],
  },
  {
    id: "prototype-migration",
    question:
      "Schema methods were moved off per-instance properties onto a prototype. Which methods moved first, which moved later, and what did each step buy?",
    gold: [
      { name: "the builder-method lazy bind", shas: ["8fcb71a5"] },
      { name: "the full per-schema memory cut", shas: ["3063993a"] },
    ],
    linkedByMiner: false,
    mustMention: [
      ["builder", "optional", "nullable"],
      ["prototype"],
      ["memory", "retained", "bytes", "closure"],
      ["bundle", "inline slot", "construction"],
    ],
  },
  {
    id: "tuple-minitems-history",
    question:
      "For closed tuples, how did toJSONSchema's minItems come to be derived from an optin/optout walk rather than prefixItems.length, and what was corrected about it afterwards?",
    gold: [
      { name: "the original bound", shas: ["97edd70a"] },
      { name: "the input-mode correction", shas: ["eb4682c9"] },
    ],
    linkedByMiner: false,
    mustMention: [["minitems"], ["optin", "optout"], ["input", "io:"], ["transform", "catch", "preprocess"]],
  },
];
