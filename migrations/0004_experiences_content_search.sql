-- Content search over knowledge (spec.md §24.2.1 / ROADMAP.md M11).
--
-- Until now `experiences` was indexed only by `related_nodes` and
-- `timestamp`: the table held the knowledge but there was no way to *find* a
-- memory by what it says. Every retrieval path had to start from a structural
-- node hit — the path WHY_MEMORY_SPIKE.md measured at MRR 0.13, against 0.75
-- for matching the question against the experience text itself. These indexes
-- are what makes the 0.75 path a shipped capability rather than a spike.
--
-- Written to be re-runnable on its own (every statement is IF NOT EXISTS /
-- ADD COLUMN IF NOT EXISTS) on top of the migration runner's own
-- already-applied check, so `runMigrations()` twice and this file twice are
-- both no-ops.

-- Vector leg. Same 1536 dims and same cosine HNSW shape as `nodes.embedding`
-- (migration 0001) — an experience and a node are embedded by the same
-- injected provider, so their columns must stay dimension-compatible.
ALTER TABLE experiences ADD COLUMN IF NOT EXISTS embedding vector(1536);

CREATE INDEX IF NOT EXISTS experiences_embedding_hnsw_idx
  ON experiences USING hnsw (embedding vector_cosine_ops);

-- Lexical legs over the experience's own text. `task || ' ' || observation`
-- is the exact text the spike matched against (both columns are NOT NULL, so
-- the concatenation is never NULL and the expression stays immutable).
--
-- Two indexes, because an experience body is *prose*, not an identifier:
--   * full-text (`to_tsvector`) ranks a natural-language question against a
--     multi-paragraph commit body — this is the leg the 0.75 came from;
--   * pg_trgm still earns its place for the identifier-ish half of a question
--     (`regexes.ts`, `$ZodCatch`, `optin`), which §9 documents `tsvector` as
--     being bad at. It is queried with word_similarity (`<%`), not plain
--     `similarity`, because whole-string trigram similarity between a short
--     question and a long body is meaningless.
CREATE INDEX IF NOT EXISTS experiences_text_fts_idx
  ON experiences USING gin (to_tsvector('english', task || ' ' || observation));

CREATE INDEX IF NOT EXISTS experiences_text_trgm_idx
  ON experiences USING gin ((task || ' ' || observation) gin_trgm_ops);
