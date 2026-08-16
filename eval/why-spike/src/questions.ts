/**
 * Questions whose answers are NOT in the code.
 *
 * Every one was derived by reading zod's actual history, then checked against
 * the current source: the code shows *what* it does, and in each case gives no
 * way to recover *why* it does it that way, what the obvious alternative broke,
 * or what was tried and rolled back. That is the class of question the e2e
 * benchmark never asked — its 24 questions all had their answers sitting in a
 * file, which is exactly where grep is strongest.
 *
 * `answerSha` is the commit that actually explains it, so retrieval can be
 * scored independently of the agent. `mustMention` is a list of synonym
 * groups; a group counts as hit if any of its variants appears in the answer.
 */
export interface WhyQuestion {
  id: string;
  question: string;
  /** The commit whose message contains the explanation. */
  answerSha: string;
  mustMention: string[][];
}

export const QUESTIONS: WhyQuestion[] = [
  {
    id: "jit-leak",
    question:
      "In the object parser's JIT fastpass, the branch handling an optional key returns early instead of running the assignment. What concrete bug did that early return fix?",
    answerSha: "69be843f",
    mustMention: [["jit"], ["leak", "swallow", "suppress", "discard"], ["success", "data", "result"]],
  },
  {
    id: "proto-record",
    question:
      "Why does the closed-key pass-through in record parsing explicitly skip the key __proto__?",
    answerSha: "4cc4053d",
    mustMention: [["__proto__"], ["prototype"], ["json.parse", "own key", "for...in", "for-in"]],
  },
  {
    id: "xor-matches",
    question:
      "Why does the issue emitted by an exclusive union (z.xor) carry a `matches` array of option indices?",
    answerSha: "4c27fe87",
    mustMention: [["matches"], ["invalid_union", "union"], ["invalid input", "empty", "no message", "bare", "nothing"]],
  },
  {
    id: "domain-lookahead",
    question: "Why does the domain regex in regexes.ts begin with a lookahead assertion?",
    answerSha: "2a5164f5",
    mustMention: [["253"], ["rfc"], ["length", "limit", "total"]],
  },
  {
    id: "anchor-helper",
    question:
      "Why is the ISO date regex built through an anchor() helper instead of an inline template literal?",
    answerSha: "e25b68e1",
    mustMention: [["esbuild"], ["tree-shak", "treeshak", "pure", "dead code"], ["interpolat", "variable", "argument"]],
  },
  {
    id: "prototype-methods",
    question:
      "Why do schema methods live on the prototype rather than as own properties on each instance, and what got measurably worse as a result?",
    answerSha: "3063993a",
    mustMention: [["prototype"], ["memory", "retained", "inline slot", "v8"], ["bundle"]],
  },
  {
    id: "catch-optin",
    question:
      "Why is $ZodCatch marked optin === 'optional' unconditionally, and what regression did that restore?",
    answerSha: "1cab6938",
    mustMention: [["absent", "missing"], ["catch"], ["4.4", "tighten", "reject", "regress", "restore"]],
  },
  {
    id: "iso-cycle",
    question:
      "Why do the ZodISODateTime / ZodISODate class definitions live in classic/schemas.ts rather than in classic/iso.ts?",
    answerSha: "dfd8766b",
    mustMention: [["circular", "cycle"], ["import"], ["rollup", "bundler", "facade", "re-export"]],
  },
  {
    id: "base64-revert",
    question:
      "Was rejecting whitespace in z.base64() ever implemented in this repository? If so, what happened to it?",
    answerSha: "23edf484",
    mustMention: [["revert"], ["accident", "mistake", "unintention", "tracking", "directly"], ["branch", "pr", "pull request"]],
  },
  {
    id: "tuple-length",
    question:
      "In the JSON Schema tuple processor, why is minItems derived from an optin/optout walk rather than from prefixItems.length?",
    answerSha: "97edd70a",
    mustMention: [["optional", "default"], ["minitems"], ["strict", "reject", "overcount", "wrong"]],
  },
];
