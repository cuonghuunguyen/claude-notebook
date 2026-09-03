-- The vector leg moved from `createFakeEmbedder` (feature hashing, 1536-dim) to
-- `createLocalEmbedder` (all-MiniLM-L6-v2, 384-dim) on 2026-09-03, because a
-- hashed cosine separated on-topic from off-topic by 0.007 and a real one
-- separates them by 0.57 — see packages/core/src/embedding.ts and BENCHMARKS.md.
-- Vectors of a different width, from a different space, are not comparable with
-- query vectors from the new one, so drop them; the next `sync` re-embeds every
-- row with a NULL embedding (listExperienceIdsMissingEmbedding).
UPDATE experiences SET embedding = NULL;
