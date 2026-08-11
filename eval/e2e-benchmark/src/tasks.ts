/**
 * The benchmark query set: realistic developer questions against zod v4,
 * each hand-labeled with the source files a correct answer lives in.
 *
 * Ground truth was labeled by manually inspecting the zod v4 source
 * (packages/zod/src/v4/{classic,core}) — every expected file was verified
 * to actually contain the implementation the question asks about. Paths
 * are suffixes relative to the repo root, matched with endsWith().
 */
export interface BenchmarkTask {
  id: string;
  /** The question as a developer/agent would actually phrase it. */
  question: string;
  /** File(s) a correct answer must point at. */
  expectedFiles: string[];
  /** Symbols a correct *answer* (agent run) should mention — grading aid. */
  expectedSymbols: string[];
}

export const TASKS: BenchmarkTask[] = [
  {
    id: "email-regex",
    question: "Where is the email validation regex defined and which check uses it?",
    expectedFiles: ["v4/core/regexes.ts", "v4/core/checks.ts"],
    expectedSymbols: ["email", "regexes"],
  },
  {
    id: "coerce",
    question: "How does z.coerce.number() coercion work and where is it implemented?",
    expectedFiles: ["v4/classic/coerce.ts"],
    expectedSymbols: ["coerce"],
  },
  {
    id: "discriminated-union",
    question: "Where is the discriminated union schema implemented and how does it pick the matching branch?",
    expectedFiles: ["v4/core/schemas.ts"],
    expectedSymbols: ["DiscriminatedUnion", "discriminator"],
  },
  {
    id: "to-json-schema",
    question: "How does converting a zod schema to JSON Schema work?",
    expectedFiles: ["v4/core/to-json-schema.ts", "v4/core/json-schema-generator.ts"],
    expectedSymbols: ["toJSONSchema", "JSONSchemaGenerator"],
  },
  {
    id: "safe-parse",
    question: "Where are parse and safeParse implemented, and how do sync and async parsing differ?",
    expectedFiles: ["v4/core/parse.ts", "v4/classic/parse.ts"],
    expectedSymbols: ["safeParse", "parseAsync"],
  },
  {
    id: "error-map",
    question: "How are custom error maps resolved when a validation issue is created?",
    expectedFiles: ["v4/core/errors.ts", "v4/core/config.ts"],
    expectedSymbols: ["errorMap", "config"],
  },
  {
    id: "registry-meta",
    question: "Where is the schema registry implemented that .meta() and globalRegistry use?",
    expectedFiles: ["v4/core/registries.ts"],
    expectedSymbols: ["registry", "globalRegistry"],
  },
  {
    id: "string-checks",
    question: "Where are string checks like min length, max length and starts_with implemented?",
    expectedFiles: ["v4/core/checks.ts"],
    expectedSymbols: ["min_length", "max_length", "starts_with"],
  },
  {
    id: "iso-datetime",
    question: "Where is ISO 8601 datetime string validation implemented?",
    expectedFiles: ["v4/classic/iso.ts", "v4/core/regexes.ts"],
    expectedSymbols: ["datetime", "iso"],
  },
  {
    id: "standard-schema",
    question: "How does zod implement the Standard Schema interface spec?",
    expectedFiles: ["v4/core/standard-schema.ts", "v4/core/core.ts"],
    expectedSymbols: ["StandardSchema", "~standard"],
  },
  {
    id: "pipe-transform",
    question: "Where are pipe and transform implemented for chaining schemas?",
    expectedFiles: ["v4/core/schemas.ts"],
    expectedSymbols: ["ZodPipe", "ZodTransform"],
  },
  {
    id: "from-json-schema",
    question: "How does building a zod schema from an existing JSON Schema document work?",
    expectedFiles: ["v4/classic/from-json-schema.ts"],
    expectedSymbols: ["fromJSONSchema"],
  },
];
