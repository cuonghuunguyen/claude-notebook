// `pnpm migrate` entry point. Kept out of migrate.ts so the published CLI bundle
// (which inlines migrate.ts) does not inherit an is-main check that would match
// the bundle's own URL and exit before the real command runs.
import { getDb } from "./db.js";
import { runMigrations } from "./migrate.js";

runMigrations()
  .then(({ applied }) => {
    if (applied.length === 0) {
      console.log(`No new migrations to apply (${getDb().path}).`);
    } else {
      console.log(`Applied to ${getDb().path}: ${applied.join(", ")}`);
    }
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
