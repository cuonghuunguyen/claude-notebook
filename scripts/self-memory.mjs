#!/usr/bin/env node
// Dogfooding wrapper: this checkout is the repo to remember unless REPO_DIR says otherwise.
// The CLI itself lives in packages/cli (published to npm as `claude-notebook`).
import path from "node:path";
import { fileURLToPath } from "node:url";
process.env["REPO_DIR"] ??= path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await import("../packages/cli/dist/cli.mjs");
