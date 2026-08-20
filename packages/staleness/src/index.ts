export * from "./types.js";
export * from "./verify.js";
// Text anchors + commit-triggered staleness (spec.md §24.2.2-§24.2.3, M12).
// Coexists with the §12 edge verifier above rather than replacing it: that one
// answers "do this edge's structural endpoints still exist", this one answers
// "has the code a memory describes moved on". The structural half retires with
// the structural graph (M15).
export * from "./gitChanges.js";
export * from "./memoryStaleness.js";
