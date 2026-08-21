// Text anchors + commit-triggered staleness (spec.md §24.2.2-§24.2.3, M12).
//
// This package used to hold two staleness notions side by side: §12's lazy
// verification, which asked "do this edge's structural endpoints still exist",
// and §24.2.3's, which asks "has the code a memory describes moved on". M15
// retired the first with the graph it verified — there are no edges and no
// structural endpoints left to check — so what the package exports now is the
// git-driven memory half alone.
export * from "./gitChanges.js";
export * from "./memoryStaleness.js";
