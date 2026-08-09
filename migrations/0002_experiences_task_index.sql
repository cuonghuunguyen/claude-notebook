-- packages/episodic's queryByTask (spec.md §8) filters on experiences.task;
-- without an index every lookup is a full scan of an append-only, ever-
-- growing table.
CREATE INDEX experiences_task_idx ON experiences (task);
