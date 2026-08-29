export * from "./corpus.js";
export * from "./distill.js";
export * from "./git.js";
export * from "./scout.js";
// `testing.js` is deliberately NOT re-exported here: it builds throwaway git
// repositories with node:child_process and belongs to test suites, not to the
// production entry point that `.claude/hooks/scout-capture.sh` loads. It is
// reachable as `@cognitive-memory/capture/testing` — see the `exports` map in
// package.json.
