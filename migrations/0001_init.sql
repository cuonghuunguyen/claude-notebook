-- Codebase Cognitive Memory — initial schema (spec.md §3-§4, §16, §18)
--
-- Provenance is stored inline as a JSONB array on nodes/edges rather than a
-- separate table: it matches the Provenance[] shape in packages/core exactly
-- and keeps single-node/edge reads to one row. Revisit only if evidence text
-- volume becomes large enough to warrant separating hot metadata from cold
-- evidence blobs (see spec.md §16 note that the graph-DB/ES split is
-- deferred, not this).
--
-- One edge row per unique (from, to, relation) triple: conflicting facts
-- about the same triple are represented as multiple provenance entries on
-- the SAME edge (see spec.md §13/§3.3 disputed status), not as duplicate
-- edge rows.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE nodes (
  id            text PRIMARY KEY, -- hash(repoId, stableSymbolPath) — spec.md §3.2, never reused
  -- Not part of the spec.md §3.1 Node type (repoId is baked into id's hash,
  -- not surfaced as its own field) — but path is only unique WITHIN a repo,
  -- so path-based lookups (incremental extraction diffing a changed file's
  -- previous symbols) need explicit repo scoping or they collide across
  -- repos. Internal-only column; rowToNode in graph-store never returns it.
  repo_id       text NOT NULL,
  type          text NOT NULL,
  name          text,
  path          text,
  summary       text,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- 1536 dims matches common embedding providers (e.g. text-embedding-3-small).
  -- The embedding provider is an injected interface at the application layer
  -- (spec.md M2 / ROADMAP.md) — this column's dimension is the one thing that
  -- isn't swappable without a migration, so pin it deliberately rather than
  -- leaving it provider-dependent.
  embedding     vector(1536),
  provenance    jsonb NOT NULL DEFAULT '[]'::jsonb,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stale', 'deleted')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX nodes_type_idx ON nodes (type);
CREATE INDEX nodes_status_idx ON nodes (status);
CREATE INDEX nodes_repo_path_idx ON nodes (repo_id, path);
-- Lexical leg of hybrid retrieval (spec.md §9) — trigram, not tsvector,
-- because it degrades gracefully on partial/typo'd code identifiers.
CREATE INDEX nodes_name_trgm_idx ON nodes USING gin (name gin_trgm_ops);
CREATE INDEX nodes_path_trgm_idx ON nodes USING gin (path gin_trgm_ops);
-- Vector leg of hybrid retrieval (spec.md §9).
CREATE INDEX nodes_embedding_hnsw_idx ON nodes USING hnsw (embedding vector_cosine_ops);

CREATE TABLE edges (
  id                text PRIMARY KEY,
  from_id           text NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  to_id             text NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  relation          text NOT NULL,
  confidence        real NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  weight            real NOT NULL CHECK (weight >= 0 AND weight <= 1),
  provenance        jsonb NOT NULL DEFAULT '[]'::jsonb,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stale', 'invalid', 'disputed')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  last_verified_at  timestamptz
);

CREATE UNIQUE INDEX edges_triple_uq ON edges (from_id, to_id, relation);
CREATE INDEX edges_from_idx ON edges (from_id);
CREATE INDEX edges_to_idx ON edges (to_id);
CREATE INDEX edges_relation_idx ON edges (relation);
CREATE INDEX edges_status_idx ON edges (status);

-- Episodic memory (spec.md §8). Append-only at the application layer
-- (packages/episodic exposes no update/delete) — related_nodes is NOT a
-- foreign key on purpose, so a node's later deletion (spec.md §18 GC) never
-- forces a rewrite of history that references it.
CREATE TABLE experiences (
  id             text PRIMARY KEY,
  task           text NOT NULL,
  observation    text NOT NULL,
  hypothesis     text,
  action         text,
  result         text,
  lessons        jsonb NOT NULL DEFAULT '[]'::jsonb,
  related_nodes  jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence     real NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  "timestamp"    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX experiences_related_nodes_idx ON experiences USING gin (related_nodes);
CREATE INDEX experiences_timestamp_idx ON experiences ("timestamp");

-- Event log (spec.md §14) — the graph is a projection over this table.
CREATE TABLE events (
  id           bigserial PRIMARY KEY,
  event_type   text NOT NULL CHECK (event_type IN (
                 'CodeChanged', 'SymbolAdded', 'SymbolRemoved', 'RelationAdded',
                 'RelationInvalidated', 'InvariantLearned', 'DecisionRecorded',
                 'ExperienceRecorded', 'ExperiencePromoted'
               )),
  payload      jsonb NOT NULL,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX events_type_idx ON events (event_type);
CREATE INDEX events_occurred_at_idx ON events (occurred_at);
