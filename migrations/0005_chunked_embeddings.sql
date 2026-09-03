-- `createLocalEmbedder` now chunks before embedding. all-MiniLM-L6-v2 truncates
-- at 256 wordpiece tokens (~1,100 chars) silently, so vectors written by the
-- unchunked version describe only the opening of every memory over that length
-- — 39% of this repo's corpus, and the longest ones at that. Not comparable
-- with chunk-pooled query vectors, so drop them; the next `sync` re-embeds.
UPDATE experiences SET embedding = NULL;
