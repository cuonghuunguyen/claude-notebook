-- Distilled memories (spec.md §26 / ROADMAP.md M19). `digest` holds a short
-- what/why/where summary of `observation`, written after capture by an LLM
-- runner (`packages/capture/src/distill.ts`).
--
-- It is DERIVED, exactly like `embedding`: `observation` is never modified
-- (§8 append-only), the digest is reproducible from it, and
-- `UPDATE experiences SET digest = NULL` returns the system to raw-commit-body
-- retrieval with nothing else to undo.
ALTER TABLE experiences ADD COLUMN digest TEXT;

-- The searched text becomes `task || ' ' || coalesce(digest, observation)`, so
-- every leg searches the digest where one exists and the raw body where it does
-- not — a half-distilled corpus is a valid corpus, which is what makes the
-- distillation pass resumable.
--
-- The triggers are dropped first: `search_text` is a VIRTUAL generated column
-- and a generated column's expression cannot be altered, so it has to be
-- dropped and re-added, and DROP COLUMN re-parses the schema that references
-- the table.
DROP TRIGGER experiences_fts_insert;
DROP TRIGGER experiences_fts_delete;
DROP TRIGGER experiences_fts_update;

ALTER TABLE experiences DROP COLUMN search_text;
ALTER TABLE experiences
  ADD COLUMN search_text TEXT
  GENERATED ALWAYS AS (task || ' ' || coalesce(digest, observation)) VIRTUAL;

-- Unchanged from migration 0001 except for the `coalesce` and for `digest`
-- joining the UPDATE OF list. That last part is load-bearing rather than
-- defensive: `digest` is the first column that changes the indexed text in
-- normal operation, so without it every distilled memory would stay indexed
-- under the raw body it was distilled away from.
CREATE TRIGGER experiences_fts_insert AFTER INSERT ON experiences BEGIN
  INSERT INTO experiences_fts (rowid, search_text)
  VALUES (new.rowid, new.task || ' ' || coalesce(new.digest, new.observation));
END;

CREATE TRIGGER experiences_fts_delete AFTER DELETE ON experiences BEGIN
  INSERT INTO experiences_fts (experiences_fts, rowid, search_text)
  VALUES ('delete', old.rowid, old.task || ' ' || coalesce(old.digest, old.observation));
END;

CREATE TRIGGER experiences_fts_update AFTER UPDATE OF task, observation, digest ON experiences BEGIN
  INSERT INTO experiences_fts (experiences_fts, rowid, search_text)
  VALUES ('delete', old.rowid, old.task || ' ' || coalesce(old.digest, old.observation));
  INSERT INTO experiences_fts (rowid, search_text)
  VALUES (new.rowid, new.task || ' ' || coalesce(new.digest, new.observation));
END;

-- Every existing row has a NULL digest, so this rebuild changes no term. It is
-- here so the index and the content table are consistent by construction after
-- the column list changed, rather than by argument.
INSERT INTO experiences_fts (experiences_fts) VALUES ('rebuild');
