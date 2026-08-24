-- Codebase Cognitive Memory — SQLite baseline (spec.md §25).
--
-- This is a REWRITE, not a translation. spec.md §25.5 decision 1: the eight
-- Postgres migrations this replaces encode the history of a schema that still
-- contained `nodes`/`edges` until 0008 dropped them, and replaying that history
-- on a new engine reproduces archaeology for no benefit. What is expressed here
-- is the schema those eight files *arrived at*, and every column below carries
-- the decision that put it there. There is deliberately no data-migration path
-- from an existing Postgres database (§25.5 decision 2): mined memories are
-- reproducible from git in ~240 ms, and scout reports — the one class that is
-- not reproducible from anything — get a one-shot export/import instead.
--
-- ## Type mapping, and the one choice worth arguing about
--
-- Timestamps are **TEXT, ISO-8601 UTC** (`2026-08-21T09:15:00.000Z`), not Unix
-- integers. §25.5 decided this for the same reason §24.2.2 chose text anchors
-- over line numbers: the database stays greppable and diffable, and a human
-- reading `sqlite3 .dump` can see what a row means. It costs a few bytes and it
-- costs nothing in comparison semantics, because a fixed-width UTC ISO string
-- sorts lexicographically in exactly timestamp order — which is why every
-- writer in `packages/graph-store` normalizes through `toIsoUtc()` rather than
-- storing whatever offset form its caller happened to hold (git's `%aI` is
-- `+02:00`-style, and mixing the two forms in one column would silently break
-- both ORDER BY and the staleness comparison).
--
-- Booleans are INTEGER 0/1 with a CHECK, because SQLite has no boolean type and
-- an unconstrained column would accept 2.
--
-- JSON (`lessons`, `related_nodes`, `anchors`, `payload`) is TEXT holding a JSON
-- array/object, read with `json_each` / `json_extract`. Postgres `jsonb` was
-- binary and indexable; here it is text and scanned (see the note on anchor
-- lookups at the bottom).
--
-- Embeddings are a 1536-element Float32 **BLOB** (6144 bytes) with no vector
-- extension at all — §25.1 measured brute-force cosine over 300x this corpus at
-- 19 ms, and §25.7 names the scale where that stops being true.

-- `schema_migrations` is deliberately NOT created here: the runner creates it
-- with `IF NOT EXISTS` before reading it, because it has to exist before any
-- migration can be recorded as applied. That is the applied-check contract
-- spec.md §25.5 decision 1 says to keep, and duplicating the DDL here would
-- make this file fail on a database the runner had already touched.

-- Episodic memory (spec.md §8), plus everything M12/M13/M16 added to it.
--
-- Append-only at the application layer: `packages/episodic` exposes no
-- update/delete, and the writes that DO touch an existing row are all derived
-- metadata *about* a memory (its embedding, its staleness verdict, its tier
-- accounting, its supersede link), never a rewrite of what it says.
CREATE TABLE experiences (
  id                TEXT PRIMARY KEY,
  task              TEXT NOT NULL,
  observation       TEXT NOT NULL,
  hypothesis        TEXT,
  action            TEXT,
  result            TEXT,
  lessons           TEXT NOT NULL DEFAULT '[]',
  -- Named for the structural node ids it held until M15, and deliberately kept
  -- (§24.7): every memory M11's capture wrote has its paths ONLY here, and
  -- `listExperiencesByAnchorPaths` matches on `anchors` OR `related_nodes` so
  -- that this repository's own mostly-pre-M12 corpus stays visible to the
  -- §24.2.3 staleness pass.
  related_nodes     TEXT NOT NULL DEFAULT '[]',
  -- Text anchors (§24.2.2): `[{ "path": ..., "symbol"?: ... }]`. Never line
  -- numbers, never node ids.
  anchors           TEXT NOT NULL DEFAULT '[]',
  confidence        REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  -- A mined memory carries its COMMIT's date, which is what makes §24.2.3's
  -- "has a newer commit touched my anchors" test meaningful.
  "timestamp"       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- spec.md §18. Nothing sets this automatically since M15 retired the
  -- edge-based rule; it is still read by every retrieval leg.
  cold              INTEGER NOT NULL DEFAULT 0 CHECK (cold IN (0, 1)),
  embedding         BLOB,
  -- spec.md §24.5 tiers. A ranking multiplier, never a filter.
  tier              TEXT NOT NULL DEFAULT 'short' CHECK (tier IN ('short', 'mid', 'long')),
  -- Raw write-on-read counters. Observational: nothing promotes on them.
  access_count      INTEGER NOT NULL DEFAULT 0,
  last_accessed     TEXT,
  -- Confirmed-session tally, recomputed from `experience_accesses`, never
  -- incremented on read. Audit figure; the promotion decision reads a narrower
  -- count computed live in `listTierStates`.
  distinct_sessions INTEGER NOT NULL DEFAULT 0,
  -- §24.5's no-self-promotion rule: the session that wrote a memory cannot
  -- promote it by reading it back. NULL for a mined commit, which correctly
  -- makes every session distinct from its (nonexistent) writer.
  writer_session    TEXT,
  tier_changed_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- Promotion credit is consumed by sequence, not by timestamp: a confirmation
  -- sharing a millisecond with the promotion it triggered must not be silently
  -- voided (migration 0005's note, kept because the hazard is the same here).
  credit_watermark  INTEGER NOT NULL DEFAULT 0,
  -- §24.2.3's persisted verdict. `0`, not nullable-unknown: a memory nothing
  -- has invalidated is trusted.
  suspect           INTEGER NOT NULL DEFAULT 0 CHECK (suspect IN (0, 1)),
  suspect_reason    TEXT,
  -- §24.2 decision 4 / §24.6. The link points FORWARD so "is this still the
  -- current answer" is a null test on the row already being scanned rather than
  -- an anti-join, and so a chain cannot fork.
  superseded_by     TEXT REFERENCES experiences(id),
  superseded_at     TEXT,
  -- §24.6: verification is an instant, not a flag. The read-time staleness test
  -- measures from max(timestamp, verified_at), or clearing `suspect` would be
  -- undone by the very next read.
  verified_at       TEXT,
  CONSTRAINT experiences_no_self_supersede
    CHECK (superseded_by IS NULL OR superseded_by <> id)
);

CREATE INDEX experiences_task_idx ON experiences (task);
CREATE INDEX experiences_timestamp_idx ON experiences ("timestamp");
CREATE INDEX experiences_cold_idx ON experiences (cold);
CREATE INDEX experiences_tier_idx ON experiences (tier);
CREATE INDEX experiences_last_accessed_idx ON experiences (last_accessed);
-- Partial, like migration 0007's: the rows worth indexing are the superseded
-- minority, and the majority (heads, where this is NULL) are exactly the rows
-- the default retrieval filter keeps.
CREATE INDEX experiences_superseded_by_idx
  ON experiences (superseded_by) WHERE superseded_by IS NOT NULL;

-- Full-text leg (spec.md §25.3). External-content FTS5 over
-- `task || ' ' || observation` — the exact text migration 0004's tsvector index
-- was built over — so the prose is stored once and the index holds only terms.
--
-- `porter unicode61` because the Postgres leg used `to_tsvector('english', ...)`,
-- which stems. Unstemmed matching would make "prototypes" miss a question asking
-- about "prototype", and the full-text leg is the strongest of the three
-- (WHY_MEMORY_SPIKE.md's 0.75 came from it).
--
-- `search_text` is a VIRTUAL generated column and exists only so FTS5 has a
-- column name to read for its content queries; it costs no storage.
ALTER TABLE experiences
  ADD COLUMN search_text TEXT
  GENERATED ALWAYS AS (task || ' ' || observation) VIRTUAL;

CREATE VIRTUAL TABLE experiences_fts USING fts5(
  search_text,
  content='experiences',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

-- The triggers concatenate explicitly rather than reading `new.search_text`:
-- generated columns are not available on NEW/OLD in a trigger body.
CREATE TRIGGER experiences_fts_insert AFTER INSERT ON experiences BEGIN
  INSERT INTO experiences_fts (rowid, search_text)
  VALUES (new.rowid, new.task || ' ' || new.observation);
END;

CREATE TRIGGER experiences_fts_delete AFTER DELETE ON experiences BEGIN
  INSERT INTO experiences_fts (experiences_fts, rowid, search_text)
  VALUES ('delete', old.rowid, old.task || ' ' || old.observation);
END;

-- Only `task`/`observation` can change the indexed text, and neither ever does
-- (§8 append-only) — the trigger exists so that a future write which DID change
-- them could not silently desynchronize the index.
CREATE TRIGGER experiences_fts_update AFTER UPDATE OF task, observation ON experiences BEGIN
  INSERT INTO experiences_fts (experiences_fts, rowid, search_text)
  VALUES ('delete', old.rowid, old.task || ' ' || old.observation);
  INSERT INTO experiences_fts (rowid, search_text)
  VALUES (new.rowid, new.task || ' ' || new.observation);
END;

-- spec.md §24.5's access join. The unit is the (memory, session) PAIR, not the
-- hit: that is what makes "one chatty session can't self-promote a memory" a
-- primary-key property instead of an assertion someone has to remember.
CREATE TABLE experience_accesses (
  experience_id  TEXT NOT NULL REFERENCES experiences(id) ON DELETE CASCADE,
  session_id     TEXT NOT NULL,
  -- 'provisional' — retrieved, outcome not yet known. Never promotes.
  -- 'confirmed'   — the task ended well AND the caller named this memory as one
  --                 it relied on. Both halves are required.
  -- 'rejected'    — the retrieving task FAILED. Counts toward demotion.
  -- 'unused'      — the task passed but this memory was not named. Neutral.
  -- 'self'        — the writer's own session read its own memory. Neutral.
  outcome        TEXT NOT NULL DEFAULT 'provisional'
    CHECK (outcome IN ('provisional', 'confirmed', 'rejected', 'unused', 'self')),
  hits           INTEGER NOT NULL DEFAULT 1,
  settle_seq     INTEGER,
  first_seen_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  settled_at     TEXT,
  PRIMARY KEY (experience_id, session_id)
);

CREATE INDEX experience_accesses_session_idx ON experience_accesses (session_id);
CREATE INDEX experience_accesses_confirmed_idx
  ON experience_accesses (experience_id, settle_seq) WHERE outcome = 'confirmed';

-- Replaces `CREATE SEQUENCE experience_settle_seq` (spec.md §25.5). A counter
-- row bumped inside the same write transaction as the settle it stamps.
--
-- One difference from `nextval()`, stated because it is a real semantic choice
-- rather than an oversight: Postgres assigned a DISTINCT value to each row an
-- UPDATE touched, while this assigns one value per settle CALL. A settle call
-- is per-session, so the granularity that matters — "this session's
-- confirmation is newer than that session's" — is preserved exactly, and
-- credit consumption (`settle_seq > credit_watermark`, `max(settle_seq)`) reads
-- the same either way because every row of one settle is consumed together.
CREATE TABLE counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

INSERT INTO counters (name, value) VALUES ('experience_settle_seq', 0);

-- Event log (spec.md §14) — the memory is a projection over this table.
--
-- The vocabulary still names the six types whose projection retired with the
-- structural graph at M15, for the reason `materializer.ts` documents: the log
-- is append-only, and a build that could not *name* those rows could not
-- describe its own history. Nothing can produce one any more.
CREATE TABLE events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type  TEXT NOT NULL CHECK (event_type IN (
                'CodeChanged', 'SymbolAdded', 'SymbolRemoved', 'RelationAdded',
                'RelationInvalidated', 'InvariantLearned', 'DecisionRecorded',
                'ExperienceRecorded', 'ExperiencePromoted', 'ExperienceSuperseded'
              )),
  payload     TEXT NOT NULL,
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX events_type_idx ON events (event_type);
CREATE INDEX events_occurred_at_idx ON events (occurred_at);

-- ## What has no index here, and why that is a decision rather than an omission
--
-- Postgres carried a GIN index on `anchors` and on `related_nodes`, which made
-- "which memories are anchored to these changed paths" an index scan. SQLite has
-- no equivalent for containment over a JSON array, so
-- `listExperiencesByAnchorPaths` scans. That is accepted on §25.1's own
-- measurement — the corpus is hundreds-to-thousands of memories, the query runs
-- once per sync/stale pass rather than per retrieval — and the alternative (a
-- normalized `experience_anchors` table) is a schema reshape, which M17 is
-- explicitly not allowed to do: a port bug and a redesign bug are
-- indistinguishable if both land at once.
--
-- The trigram and vector legs have no index for the same reason stated in
-- `trigram.ts` and `vector.ts`: both are full scans scored in JS, and §25.7
-- names the corpus size at which that stops being good enough.
