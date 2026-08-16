/**
 * Target: zod v4 (`packages/zod/src/v4/{classic,core}`) — few, very large
 * TypeScript modules, schemas defined through `export const X = $constructor(...)`
 * rather than `class`/`function` declarations.
 *
 * Ground truth was labeled by manually inspecting the zod v4 source — every
 * expected file was verified to actually contain the implementation the
 * question asks about. Paths are suffixes, matched with endsWith().
 *
 * The `hops` field is deliberately left unset here: this question set predates
 * the single/multi-hop split and labeling it after the fact would be a
 * post-hoc rationalisation, not a design. See the lodash target for a set
 * where the split was chosen up front.
 */
import fs from "node:fs";
import path from "node:path";
import type { BenchTarget, BenchmarkTask } from "./types.js";

const TASKS: BenchmarkTask[] = [
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

export const zodTarget: BenchTarget = {
  key: "zod",
  repoId: "zod-v4-benchmark",
  origin: "https://github.com/colinhacks/zod (default branch)",
  dirEnv: "ZOD_DIR",
  agentPathHint: "the exact source file path(s) under packages/zod/src/v4",
  root: (cloneDir) => path.join(cloneDir, "packages", "zod", "src", "v4"),
  /** Indexed scope: classic + core, tests excluded — what an agent memory would index. */
  sourceGlobs: (root) => [
    `${root}/classic/**/*.ts`,
    `${root}/core/**/*.ts`,
    `!${root}/classic/tests/**`,
    `!${root}/core/tests/**`,
  ],
  indexedFiles: (root) => {
    const files: string[] = [];
    for (const dir of ["classic", "core"]) {
      const base = path.join(root, dir);
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path.join(base, entry.name));
      }
    }
    return files;
  },
  episodicSeeds: [
    {
      fileSuffix: "v4/core/schemas.ts",
      lesson:
        "[synthetic] core/schemas.ts is a ~10k-line module; schema classes are defined via $constructor, not `class X {}` declarations.",
    },
    {
      fileSuffix: "v4/core/checks.ts",
      lesson:
        "[synthetic] String/number checks live in core/checks.ts as $ZodCheck* constructors; the regexes they use live in core/regexes.ts.",
    },
  ],
  agentTaskIds: [
    "email-regex",
    "coerce",
    "discriminated-union",
    "safe-parse",
    "registry-meta",
    "standard-schema",
  ],
  tasks: TASKS,
};
