# Codebase Cognitive Memory

A persistent, graph-based memory layer for coding agents — structural graph
as source of truth, semantic graph + episodic memory layered on top, hybrid
search + reasoning-guided traversal for retrieval.

- **`spec.md`** — the full technical spec. Read this first; every design
  decision in the code traces back to a section here.
- **`ROADMAP.md`** — milestone breakdown (M0-M7) with acceptance criteria
  and current status.
- **`AGENT_HARNESS.md`** — protocol for any Claude Code session (this one
  resumed, or one spawned automatically by a Routine) to keep building this
  milestone-by-milestone without needing prior conversation context.

## Local setup

```bash
pnpm install
bash scripts/setup-dev-db.sh        # installs/starts Postgres+pgvector+pg_trgm locally
export DATABASE_URL="postgres://postgres:postgres@localhost:5432/cognitive_memory"
pnpm --filter @cognitive-memory/graph-store migrate

pnpm build
pnpm typecheck
pnpm lint
pnpm test                            # unit tests always run; integration tests
                                      # need DATABASE_URL and self-skip without it
```

`scripts/setup-dev-db.sh` is the verified path in sandboxed dev environments
without a Docker daemon. If your machine has Docker, a `docker-compose.yml`
with the same Postgres+pgvector image works too — either way, run the
migration before the tests.

For integration tests specifically, point `DATABASE_URL` at a disposable
database (e.g. `cognitive_memory_test`) so test runs don't pollute your dev
data.

## Repo layout

```
spec.md                 the contract
ROADMAP.md               milestones + acceptance criteria + status
AGENT_HARNESS.md          protocol for autonomous continuation
migrations/               SQL schema migrations
scripts/setup-dev-db.sh   local Postgres+pgvector+pg_trgm setup
packages/
  core/                   shared types (Node, Edge, Provenance, Experience)
  graph-store/            Postgres client, migration runner, typed CRUD
  structural/             ts-morph based structural extractor (M1)
  ...                     more packages land as later milestones ship
```

## CI

`.github/workflows/ci.yml` runs typecheck, lint, build, and the full test
suite (including integration tests) against a real Postgres+pgvector
service container on every push — the same commands as local setup above,
so a green CI run and a green local run mean the same thing.
