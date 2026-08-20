-- Read-repair: supersede chains + verification stamps
-- (spec.md §24.2 decision 4 / §24.6, ROADMAP.md M13).
--
-- M12 gave a memory a way to be *doubted* (`suspect` / `suspect_reason`) but no
-- way to be *answered*. This migration adds the two answers read-repair can
-- give a doubted memory:
--
--   * it was wrong  -> a corrected memory is recorded and the old one is linked
--                      to it (`superseded_by` / `superseded_at`);
--   * it was right  -> the doubt is resolved as of an instant (`verified_at`).
--
-- ## Why the link points forward (old -> new) and not backward
--
-- The obvious column is `supersedes` on the *new* row ("this memory replaces
-- that one"), which is the direction the write happens in. It is not the
-- direction the *reads* happen in. Every read this milestone adds asks one of
-- two questions:
--
--   "is this memory still the current answer?"  -> `superseded_by IS NULL`
--   "what replaced it?"                         -> follow `superseded_by`
--
-- With a backward `supersedes` column the first question — the one on the hot
-- retrieval path, evaluated for every candidate row in three search legs —
-- becomes an anti-join (`NOT EXISTS (SELECT 1 FROM experiences s WHERE
-- s.supersedes = e.id)`). With the forward column it is a null test on the row
-- already being scanned. Storing both directions would make the cheap read
-- available at the cost of two columns that can disagree, and nothing here
-- needs the backward direction that an index scan on `superseded_by` cannot
-- answer in one lookup.
--
-- A single forward column also makes the chain non-forking by construction:
-- a memory has at most one successor because it has one column to name it in.
-- "Chain head" is therefore well defined without a uniqueness constraint, and
-- `superseded_by IS NULL` is exactly "head".
--
-- `text`, not `uuid`: `experiences.id` is `text` (migration 0001) because ids
-- are minted by callers, not by the database.
ALTER TABLE experiences
  ADD COLUMN IF NOT EXISTS superseded_by text REFERENCES experiences(id);

-- When the supersede happened, as distinct from when either memory was written.
-- A correction can be recorded long after the memory it corrects, and long
-- after the commit that invalidated it; without this the only timeline
-- available is the two memories' own timestamps, which answer a different
-- question.
ALTER TABLE experiences
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz;

-- ## Why verification needs a stamp and not just `suspect = false`
--
-- M12's staleness test is recomputed at read time from git (`flagPossiblyStale`)
-- as well as persisted at sync time. So clearing `suspect` alone does not
-- survive: the commit that triggered the flag is still newer than the memory's
-- `timestamp`, so the very next read re-derives the same verdict and the repair
-- is silently undone. "This memory was checked against the code as of instant
-- T" is a fact about the memory that the read-time test has to be able to see,
-- which makes it a column rather than a flag flip.
--
-- The staleness test then reads `max(timestamp, verified_at)` (core's
-- `stalenessAsOf`) instead of `timestamp`, so a verified memory is re-flagged
-- only by commits made after its verification — which is the correct behaviour,
-- not a suppression: the anchored files can move again tomorrow.
ALTER TABLE experiences
  ADD COLUMN IF NOT EXISTS verified_at timestamptz;

-- No memory may supersede itself. A self-link would make the row invisible to
-- every default retrieval (`superseded_by IS NULL` fails) with no successor to
-- take its place — the one shape of this data that silently deletes knowledge.
-- Longer cycles are prevented at write time (`supersedeExperience` walks the
-- successor chain before linking); a CHECK cannot express those, but it can
-- express the degenerate case that a single buggy UPDATE would produce.
DO $$
BEGIN
  ALTER TABLE experiences ADD CONSTRAINT experiences_no_self_supersede
    CHECK (superseded_by IS NULL OR superseded_by <> id);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- Partial index: the rows worth indexing are the superseded minority (chain
-- history lookups follow this column), while the majority — heads, where the
-- column is NULL — are exactly the rows the default retrieval filter keeps, and
-- a planner scanning for `IS NULL` over most of the table wants a sequential
-- scan anyway.
CREATE INDEX IF NOT EXISTS experiences_superseded_by_idx
  ON experiences (superseded_by) WHERE superseded_by IS NOT NULL;

-- spec.md §14's event vocabulary gains the supersede link.
--
-- Unlike `cold` (§18) and `suspect` (§24.2.3), which are derived verdicts a
-- rebuild can recompute, a supersede link is *knowledge the system was told*:
-- an agent read the code and decided the old memory was wrong. A
-- rebuild-from-events that could not replay it would resurrect corrected-away
-- memories into the default retrieval path — it would not merely lose metadata,
-- it would start answering questions with knowledge that has been retracted.
-- `verified_at` is deliberately NOT eventful by the same test: losing it on
-- replay re-raises a flag, which is conservative and self-healing.
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_event_type_check;
ALTER TABLE events ADD CONSTRAINT events_event_type_check CHECK (event_type IN (
  'CodeChanged', 'SymbolAdded', 'SymbolRemoved', 'RelationAdded',
  'RelationInvalidated', 'InvariantLearned', 'DecisionRecorded',
  'ExperienceRecorded', 'ExperiencePromoted', 'ExperienceSuperseded'
));
