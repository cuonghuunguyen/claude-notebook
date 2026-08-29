-- The fake embedder stopped hashing function words (packages/core/src/embedding.ts,
-- 2026-08-28 real-prompt calibration). Vectors written by the old tokenizer are
-- not comparable with query vectors from the new one, so drop them; the next
-- `sync` re-embeds every row with a NULL embedding (listExperienceIdsMissingEmbedding).
UPDATE experiences SET embedding = NULL;
