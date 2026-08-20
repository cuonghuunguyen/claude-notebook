/**
 * A self-contained "why" corpus and the questions it should answer.
 *
 * The shape mirrors `questions.ts` (which asks the same class of question over
 * zod's real history): every question's answer is in the *history*, not in the
 * source, so no amount of reading the fixture files could produce it. Each
 * question is phrased the way someone would actually ask it — a paraphrase,
 * sharing only a couple of content words with the commit body — because that is
 * the regime the node-gated path failed in.
 *
 * **The distractors are the part that makes this an eval rather than a smoke
 * test.** Each answering commit shares its file with a varying number of later
 * commits (1 to 4, so the answer's recency rank is not the same constant for
 * every question), and each distractor is written to reuse its answer's own
 * vocabulary — the same subsystem nouns, the same verbs — while explaining
 * something else entirely. An earlier version of this fixture used generic
 * filler that also announced itself as filler in its own body; by-meaning
 * scored a flat 1.000 against it and the node-gated arm a flat 0.250, both of
 * which were arithmetic properties of the fixture rather than measurements.
 * Nothing here may state what it is *for*: a distractor that says "this is not
 * the answer" is a distractor the lexical leg can trivially avoid.
 */
import type { FixtureCommit } from "@cognitive-memory/capture/testing";

export interface KnowledgeEvalQuestion {
  id: string;
  question: string;
  /** The plain-text anchor the answering memory carries — shared with a distractor. */
  anchor: string;
  /** Subject of the commit that actually explains it, i.e. the answering memory's `task`. */
  answerSubject: string;
}

export const KNOWLEDGE_EVAL_QUESTIONS: KnowledgeEvalQuestion[] = [
  {
    id: "fastpass-early-return",
    question:
      "In the object parser's fast path, the branch for an optional key returns before assigning. What concrete bug did changing that fix?",
    anchor: "src/parse.ts",
    answerSubject:
      "fix: keep the fast-path result instead of returning from the optional branch",
  },
  {
    id: "proto-skip",
    question: "Why is the __proto__ key treated specially when copying closed keys through?",
    anchor: "src/record.ts",
    answerSubject:
      "fix: do not pass a prototype key through the closed-key copy",
  },
  {
    id: "base64-revert",
    question:
      "Was rejecting whitespace inside base64 input ever shipped here, and if so what became of it?",
    anchor: "src/base64.ts",
    answerSubject:
      "revert: allow surrounding blank characters in the base64 check again",
  },
  {
    id: "domain-lookahead",
    question: "Why does the hostname pattern start with a lookahead instead of just matching labels?",
    anchor: "src/regexes.ts",
    answerSubject:
      "fix: assert the overall hostname budget before matching any label",
  },
  {
    id: "anchor-helper",
    question:
      "Why is the date pattern assembled by a helper call rather than written out as one template literal?",
    anchor: "src/iso.ts",
    answerSubject:
      "fix: build the date pattern through a helper call",
  },
  {
    id: "prototype-methods",
    question:
      "What got measurably worse when the schema methods were moved off each instance, and why was it accepted?",
    anchor: "src/schema.ts",
    answerSubject:
      "perf: move the schema methods off every instance",
  },
  {
    id: "catch-optin",
    question: "What behaviour broke when the catch wrapper stopped treating an absent key as optional?",
    anchor: "src/catch.ts",
    answerSubject:
      "fix: treat an absent key as optional in the catch wrapper unconditionally",
  },
  {
    id: "tuple-minitems",
    question:
      "Why is the lower bound for a tuple worked out by walking the items instead of counting them?",
    anchor: "src/tuple.ts",
    answerSubject:
      "fix: derive the tuple lower bound from a walk over the items",
  },
];


/**
 * One entry per question: the anchor, the commit that answers it, and the
 * later commits on the same file that do not.
 */
interface AnchorCase {
  file: string;
  answer: { subject: string; body: string; date: string };
  distractors: Array<{ subject: string; body: string; date: string }>;
}

const ANCHOR_CASES: AnchorCase[] = [
  {
    file: "src/parse.ts",
    answer: {
      subject: "fix: keep the fast-path result instead of returning from the optional branch",
      body:
        "The optional-key branch left the fast path before running its assignment, so a " +
        "value that had already parsed successfully was thrown away and the caller received " +
        "undefined for the whole object. It reads like a compiler problem and it is not: the " +
        "branch is the only place the fast path can put the value, and the alternative — " +
        "re-walking the declared shape once per optional key — was measurably slower on " +
        "every benchmark we have.",
      date: "2024-01-02T10:00:00Z",
    },
    distractors: [
      {
        subject: "perf: hoist the optional-key lookup out of the fast path's inner loop",
        body:
          "The fast path asked whether each declared key was optional on every iteration, " +
          "which meant the same lookup ran once per key per parse. The declared shape cannot " +
          "change between iterations, so the flags are computed once before the loop and read " +
          "from there. The value the branch assigns and the object the caller receives are " +
          "byte-identical before and after; only the number of lookups changes.",
        date: "2025-02-10T10:00:00Z",
      },
      {
        subject: "refactor: pass the prepared plan into the fast path rather than deriving it",
        body:
          "Two call sites had grown that each derived the same parse plan from the declared " +
          "shape immediately before handing control to the fast path. Deriving it in the " +
          "caller and passing it in removes the duplicate derivation and makes the fast " +
          "path's input explicit. No branch inside the fast path changed, and the optional " +
          "and required paths both return exactly what they returned before.",
        date: "2025-06-10T10:00:00Z",
      },
      {
        subject: "chore: tighten the fast path's declared input type",
        body:
          "The signature accepted a wider shape than the body could actually handle, and " +
          "callers kept reading that width as permission to pass a partially built plan, " +
          "which the fast path then rejected at runtime. Narrowing the type moves that " +
          "rejection to compile time because the runtime rejection was arriving too late to " +
          "be useful. Nothing about how a value is assigned or returned is touched here.",
        date: "2025-11-10T10:00:00Z",
      },
    ],
  },
  {
    file: "src/record.ts",
    answer: {
      subject: "fix: do not pass a prototype key through the closed-key copy",
      body:
        "Copying every own key straight through meant a decoded payload carrying that one " +
        "special inherited-slot name could reach the prototype chain of the object we hand " +
        "back. Skipping exactly that key is deliberate: switching the copy to an inherited " +
        "walk would also pull keys the caller never declared, and the closed-key contract " +
        "promises the opposite of that.",
      date: "2024-02-02T10:00:00Z",
    },
    distractors: [
      {
        subject: "perf: copy closed keys in one pass instead of two",
        body:
          "The closed-key copy walked the declared keys to validate them and then walked " +
          "them again to write them through, which meant every key was visited twice for no " +
          "reason once validation stopped short-circuiting. Merging the two walks keeps the " +
          "same rejection order and the same resulting object; it only stops paying for the " +
          "second traversal of a payload we have already inspected.",
        date: "2025-03-11T10:00:00Z",
      },
      {
        subject: "refactor: let the record walker report progress to its caller",
        body:
          "Callers that copy very large payloads had no way to observe how far the walk had " +
          "got, and were reaching into internals to guess. The walker now yields its position " +
          "as it goes, so that a caller can report progress instead of depending on anything " +
          "private. Which keys are copied through, and which are declined, is unchanged.",
        date: "2025-08-11T10:00:00Z",
      },
    ],
  },
  {
    file: "src/base64.ts",
    answer: {
      subject: "revert: allow surrounding blank characters in the base64 check again",
      body:
        "This undoes the stricter check. The stricter version was never meant to reach the " +
        "release line at all — it was pushed straight onto it instead of through its review " +
        "branch, so nobody looked at it before it shipped. Undone because tightening an " +
        "accepted input silently is breaking, not because the stricter rule is wrong; it can " +
        "come back through a major.",
      date: "2024-03-02T10:00:00Z",
    },
    distractors: [
      {
        subject: "perf: share the base64 alphabet table with the url-safe variant",
        body:
          "Two tables held the same sixty-four entries with two substitutions differing, and " +
          "both were rebuilt per module load. One table plus a substitution map is smaller " +
          "and is built once. Which strings the check accepts, blank characters included, is " +
          "deliberately untouched here — this is a change to how the table is stored, not to " +
          "what the validator will take.",
        date: "2025-04-12T10:00:00Z",
      },
      {
        subject: "chore: reject a base64 call shape the runtime already refused",
        body:
          "The exported signature accepted an options object the implementation never read, " +
          "so callers passing it believed they had configured something. The type now refuses " +
          "it at compile time instead of accepting it and ignoring it. The accepted input " +
          "language of the check itself does not change in either direction.",
        date: "2025-09-12T10:00:00Z",
      },
      {
        subject: "refactor: move the base64 check behind the shared validator entry point",
        body:
          "It was the last validator still reachable by its own direct export, which meant " +
          "one code path skipped the shared argument normalization every other check goes " +
          "through, and that gap had already produced one reported bug. Routing it through the " +
          "same entry point removes the inconsistency without altering which inputs it takes.",
        date: "2026-01-12T10:00:00Z",
      },
      {
        subject: "chore: document the base64 check's accepted alphabet in its own file",
        body:
          "The accepted alphabet was described in a release note and nowhere near the code, " +
          "so every reader rediscovered it from the table. Writing it down next to the table " +
          "is not a behaviour change; it exists because the same question kept being asked " +
          "and answered from first principles.",
        date: "2026-04-12T10:00:00Z",
      },
    ],
  },
  {
    file: "src/regexes.ts",
    answer: {
      subject: "fix: assert the overall hostname budget before matching any label",
      body:
        "A hostname is capped at two hundred and fifty three characters in total by the " +
        "relevant standard, and a per-label quantifier cannot express a cap on the whole " +
        "string no matter how it is nested. Opening with an assertion that consumes nothing " +
        "and only checks the remaining length is the one construct that can, which is why " +
        "the pattern begins with something that looks redundant.",
      date: "2024-04-02T10:00:00Z",
    },
    distractors: [
      {
        subject: "perf: compile the shared hostname patterns once at module load",
        body:
          "Each pattern was being constructed per call, so a validator used in a loop paid " +
          "the construction cost on every iteration. Building them once at load keeps the " +
          "same patterns, the same label quantifiers and the same leading assertion; it only " +
          "stops rebuilding them. Measured on the large-input benchmark this is the single " +
          "largest win in the module.",
        date: "2025-05-13T10:00:00Z",
      },
      {
        subject: "refactor: give each hostname label quantifier a name",
        body:
          "The pattern was one long literal in which the label and separator quantifiers were " +
          "impossible to tell apart while reading, so an earlier edit had already introduced a " +
          "bug by changing the wrong one. Naming the pieces and composing them produces a " +
          "character-for-character identical pattern, which a test asserts.",
        date: "2025-10-13T10:00:00Z",
      },
    ],
  },
  {
    file: "src/iso.ts",
    answer: {
      subject: "fix: build the date pattern through a helper call",
      body:
        "The bundler refuses to consider a pattern literal side-effect free once a value is " +
        "spliced into it, so its unused-code pass kept the entire module in every output " +
        "even for consumers that never touch dates. Passing the pieces to a helper keeps the " +
        "splice out of the literal itself and the pass can drop the module again. The helper " +
        "exists for that reason alone and not for legibility.",
      date: "2024-05-02T10:00:00Z",
    },
    distractors: [
      {
        subject: "refactor: expose the pieces the date helper composes",
        body:
          "Consumers building their own date patterns were copying the fragments out of this " +
          "module by hand and drifting from it whenever it changed. Exporting the fragments " +
          "the helper already composes gives them one source instead of a copy each. The " +
          "helper keeps composing them exactly as before, and its output is unchanged.",
        date: "2025-07-14T10:00:00Z",
      },
      {
        subject: "chore: pin the date helper's output in a snapshot",
        body:
          "Two separate changes to this module had altered the produced pattern without any " +
          "test noticing, because every test asserted on parse results rather than on the " +
          "pattern itself. A snapshot of the composed pattern makes that class of change " +
          "visible. No production code is touched.",
        date: "2025-12-14T10:00:00Z",
      },
      {
        subject: "perf: memoize the date helper per argument set",
        body:
          "The helper was invoked once per schema construction with the same arguments almost " +
          "every time, and each call recomposed the same pattern. Caching on the argument set " +
          "returns the identical pattern object instead. What the helper composes, and why it " +
          "is a helper at all, are both unchanged.",
        date: "2026-03-14T10:00:00Z",
      },
    ],
  },
  {
    file: "src/schema.ts",
    answer: {
      subject: "perf: move the schema methods off every instance",
      body:
        "Defining the methods once on the shared object rather than per instance cut a " +
        "meaningful slice off the shipped bundle, and the engine now retains more per " +
        "instance than before because the inline slots it had reserved no longer cover the " +
        "method properties. We took the trade knowingly: bundle size is paid by every " +
        "consumer on every page load, retained bytes only by the ones holding many live " +
        "instances at once.",
      date: "2024-06-02T10:00:00Z",
    },
    distractors: [
      {
        subject: "chore: give the shared schema object a stable tag",
        body:
          "Tools inspecting a live schema instance had nothing stable to key on and were " +
          "sniffing method names off the shared object, which broke whenever a method was " +
          "renamed. A fixed tag gives them something that does not move, so that a rename " +
          "stops being a breaking change for them. Where the methods live is untouched.",
        date: "2025-01-15T10:00:00Z",
      },
      {
        subject: "perf: build the shared method object once per schema kind",
        body:
          "Each schema kind was assembling its own shared object at first construction, so the " +
          "assembly cost was paid once per kind per process rather than once per build. " +
          "Hoisting it to module scope pays it at load instead. The methods are the same " +
          "methods on the same shared object; only when it is assembled changes.",
        date: "2025-07-15T10:00:00Z",
      },
    ],
  },
  {
    file: "src/catch.ts",
    answer: {
      subject: "fix: treat an absent key as optional in the catch wrapper unconditionally",
      body:
        "Tightening this in the previous minor made a schema reject input it had accepted " +
        "since the first release: a missing key stopped reaching the fallback and surfaced " +
        "as a plain validation failure instead. Restoring the unconditional form brings back " +
        "the older contract. The tightened reading is arguably the more correct one, which is " +
        "why it was tried, and it is still breaking, which is why it is gone.",
      date: "2024-07-02T10:00:00Z",
    },
    distractors: [
      {
        subject: "refactor: forward the original issue list into the catch fallback",
        body:
          "The fallback received only a flag saying that validation had failed, so a consumer " +
          "wanting to log what actually went wrong had to re-run the inner schema. Passing " +
          "the collected issues through gives it the information directly. Which inputs reach " +
          "the fallback at all, absent keys included, is decided elsewhere and unchanged here.",
        date: "2025-02-16T10:00:00Z",
      },
      {
        subject: "perf: skip building the catch wrapper's issue list when nothing reads it",
        body:
          "Every failing parse inside a catch wrapper built a full issue list that the common " +
          "fallback then discarded unread. The list is now built lazily on first access. A " +
          "fallback that does read it sees exactly the same issues as before, in the same " +
          "order.",
        date: "2025-08-16T10:00:00Z",
      },
      {
        subject: "chore: name the catch wrapper's two failure paths in its own types",
        body:
          "One path is a failure the wrapper is meant to absorb and the other is a failure it " +
          "must let through, and both arrived at the fallback as the same anonymous shape, " +
          "which callers routinely conflated into one bug report. Distinct named types make " +
          "the difference checkable. Runtime behaviour is identical.",
        date: "2026-02-16T10:00:00Z",
      },
    ],
  },
  {
    file: "src/tuple.ts",
    answer: {
      subject: "fix: derive the tuple lower bound from a walk over the items",
      body:
        "Counting the declared items overcounts the moment one of them is optional or has a " +
        "fallback, and the emitted schema then rejects a shorter input that the validator " +
        "itself accepts. Walking the items and stopping at the first one that need not be " +
        "present is the only way to get a bound the two agree on, so the length of the " +
        "declared list is deliberately not used here.",
      date: "2024-08-02T10:00:00Z",
    },
    distractors: [
      {
        subject: "refactor: reuse the tuple item walker for the rest element",
        body:
          "The rest element had its own near-duplicate walk over the declared items, which " +
          "had already drifted once from the one used for the fixed positions and caused a " +
          "bug there. Both now go through the same walker instead. The lower bound it derives, " +
          "and how that bound is derived, are unchanged.",
        date: "2025-03-17T10:00:00Z",
      },
    ],
  },
];

/**
 * The corpus, oldest first: every answering commit, then the later commits that
 * share its file. Every body is long enough and explanatory enough to pass
 * `isExplanatory`.
 */
export const KNOWLEDGE_EVAL_COMMITS: FixtureCommit[] = [
  ...ANCHOR_CASES.map<FixtureCommit>((c) => ({
    subject: c.answer.subject,
    body: c.answer.body,
    files: [c.file],
    date: c.answer.date,
  })),
  ...ANCHOR_CASES.flatMap((c) =>
    c.distractors.map<FixtureCommit>((d) => ({
      subject: d.subject,
      body: d.body,
      files: [c.file],
      date: d.date,
    }))
  ),
];

/** How many later commits share each answer's file — the node-gated arm's real difficulty. */
export const DISTRACTORS_PER_ANCHOR: Record<string, number> = Object.fromEntries(
  ANCHOR_CASES.map((c) => [c.file, c.distractors.length])
);
