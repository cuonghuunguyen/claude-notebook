-- Memory tiers: access-driven promotion (spec.md §24.5 / ROADMAP.md M16).
--
-- §24.5 left one thing deliberately undecided: *access is not correctness*.
-- A plausible-but-wrong memory that keeps getting retrieved would climb tiers
-- on raw hit counts. This schema encodes M16's answer to that, so the answer
-- is enforced by the data model rather than by convention:
--
--   * `experiences.access_count` / `last_accessed` are the RAW write-on-read
--     counters §24.5 asks for. They are observational: nothing promotes on
--     them. They exist so the raw-counting baseline stays measurable against
--     the gated one on the same rows (eval/tier-promotion).
--   * `experiences.distinct_sessions` is the *confirmed*-session tally —
--     sessions whose task ended well and that actually relied on the memory.
--     It is recomputed from `experience_accesses`, never incremented on read.
--     Note it is a denormalized audit/reporting figure, NOT what a promotion
--     decision reads: promotion reads a narrower count computed live in
--     `listTierStates` (confirmed sessions settled strictly after the memory
--     entered its current tier, inside the sustained-access window), because
--     a single all-time column cannot express "since this tier" or "expired".
--   * `experience_accesses` is the join §24.5's candidate 2 (task-outcome
--     feedback) needs: one row per (memory, session), landing `provisional`
--     at retrieval time and settled once the task's outcome is known.
--
-- The unit is the (memory, session) PAIR, not the hit: that is what makes
-- "one chatty session can't self-promote a memory" a primary-key property
-- instead of an assertion.

ALTER TABLE experiences
  ADD COLUMN IF NOT EXISTS tier text NOT NULL DEFAULT 'short'
    CHECK (tier IN ('short', 'mid', 'long'));
ALTER TABLE experiences
  ADD COLUMN IF NOT EXISTS access_count integer NOT NULL DEFAULT 0;
ALTER TABLE experiences
  ADD COLUMN IF NOT EXISTS last_accessed timestamptz;
ALTER TABLE experiences
  ADD COLUMN IF NOT EXISTS distinct_sessions integer NOT NULL DEFAULT 0;
-- The session that WROTE the memory, when there was one (a mined commit has
-- no session, so this stays NULL and every session is "distinct from the
-- writer"). Needed for §24.5's no-self-promotion rule: the session that just
-- recorded a memory retrieving it back must not be what promotes it.
ALTER TABLE experiences
  ADD COLUMN IF NOT EXISTS writer_session text;
-- When the row entered its current tier. Doubles as the reset point for the
-- consecutive-rejection counter, so a demotion clears that counter without a
-- second column to keep in sync.
ALTER TABLE experiences
  ADD COLUMN IF NOT EXISTS tier_changed_at timestamptz NOT NULL DEFAULT now();
-- Promotion credit is consumed by a tier change, and "consumed" has to be
-- expressed on something strictly monotonic — NOT on `tier_changed_at`.
--
-- Timestamps do not work here. A settle and the promotion it triggers share
-- one `now`, so a "credit settled strictly after the tier change" predicate
-- silently voids any OTHER confirmation that landed in the same millisecond,
-- permanently (tier_changed_at never moves back). Long-term would then cost
-- four confirmed sessions instead of the three §24.5 states, non-
-- deterministically. `settle_seq` below is drawn from a sequence, so
-- consumption is exact regardless of clock resolution or ties.
ALTER TABLE experiences
  ADD COLUMN IF NOT EXISTS credit_watermark bigint NOT NULL DEFAULT 0;

-- Tier is a §11 ranking multiplier, never a filter (§24.5), so this index is
-- for the maintenance/decay scan and for the dogfood distribution query — not
-- for retrieval, which must keep spanning every tier.
CREATE INDEX IF NOT EXISTS experiences_tier_idx ON experiences (tier);
CREATE INDEX IF NOT EXISTS experiences_last_accessed_idx ON experiences (last_accessed);

CREATE SEQUENCE IF NOT EXISTS experience_settle_seq;

CREATE TABLE IF NOT EXISTS experience_accesses (
  experience_id text NOT NULL REFERENCES experiences(id) ON DELETE CASCADE,
  session_id    text NOT NULL,
  -- 'provisional' — retrieved, outcome not yet known. Never promotes.
  -- 'confirmed'   — the retrieving task ended well AND the caller named this
  --                 memory as one it actually relied on. Both halves are
  --                 required: see `settleSessionAccesses` for why a bare
  --                 "the task passed" is not enough to confirm anything.
  -- 'rejected'    — the retrieving task FAILED. Negative: counts toward
  --                 demotion, not promotion.
  -- 'unused'      — the task passed but this memory was not among the ones it
  --                 relied on (or the caller could not say which were).
  --                 Neutral: promotes nothing, demotes nothing.
  -- 'self'        — the writer's own session read its own memory. Neutral by
  --                 construction: neither promotes nor demotes.
  outcome       text NOT NULL DEFAULT 'provisional'
    CHECK (outcome IN ('provisional', 'confirmed', 'rejected', 'unused', 'self')),
  hits          integer NOT NULL DEFAULT 1,
  -- Assigned from `experience_settle_seq` when the access is settled, so
  -- promotion credit can be consumed by sequence rather than by timestamp.
  -- NULL while provisional.
  settle_seq    bigint,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  settled_at    timestamptz,
  PRIMARY KEY (experience_id, session_id)
);

-- Settling a session walks its own rows; the decay/promotion scan walks a
-- memory's rows. Both directions are indexed (the PK covers the second).
CREATE INDEX IF NOT EXISTS experience_accesses_session_idx
  ON experience_accesses (session_id);
CREATE INDEX IF NOT EXISTS experience_accesses_confirmed_idx
  ON experience_accesses (experience_id, settle_seq)
  WHERE outcome = 'confirmed';
