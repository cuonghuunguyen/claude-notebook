-- spec.md §18 Garbage Collection & Retention: experiences whose lessons have
-- been promoted to a durable semantic edge move to cold storage — still
-- queryable, but excluded from packages/episodic's default queries so the
-- hot vector/index path stays bounded by "currently load-bearing" history,
-- not the full append-only log.

ALTER TABLE experiences ADD COLUMN cold boolean NOT NULL DEFAULT false;

CREATE INDEX experiences_cold_idx ON experiences (cold);
