import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /**
     * This package's suites must not run concurrently WITH EACH OTHER.
     *
     * `integration.test.ts`'s last case exercises spec.md §14's
     * rebuild-from-events, which calls `wipeMaterializedGraph()` — a
     * `TRUNCATE` of `nodes`/`edges`/`experiences` across the whole database,
     * not just that file's own rows. It is deliberately the last case in its
     * own file for that reason, but vitest runs a package's test FILES in
     * parallel workers, so the truncate lands in the middle of whatever the
     * sibling suites are doing. Observed: `supersede.integration.test.ts`
     * failing with `no such experience to supersede` because its fixtures were
     * truncated out from under it mid-run.
     *
     * Serializing the files makes the wipe land between suites instead of
     * inside one. The alternative — giving the rebuild test its own database —
     * is the better long-term answer but is a change to how every suite in the
     * repo gets its connection, which is not this milestone's business.
     *
     * Cross-PACKAGE safety is already handled: pnpm's topological script
     * ordering means no package depending on graph-store starts its own tests
     * until this package's are finished.
     */
    fileParallelism: false,
  },
});
