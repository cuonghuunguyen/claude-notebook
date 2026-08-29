# Quality log

One row per finished task, written by `.claude/hooks/quality-gate.sh`. The
point is early detection: a failing row here means the problem was caught at
the end of the task that caused it, not at the next milestone's CI run.

| When (UTC) | Verdict | Files | Checks |
|---|---|---|---|
| 2026-08-16 12:27 | pass | 1 | typecheck ✓ 6s · lint ✓ 3s · core ✓ |
| 2026-08-16 12:27 | FAIL | 1 | typecheck ✗ · lint ✗ · core ✓ |
| 2026-08-16 12:27 | FAIL | 1 | typecheck ✗ · lint ✗ · core ✓ |
| 2026-08-27 09:52 | pass | 2 | typecheck ✓ 2s · lint ✓ 3s · graph-store ✓ |
| 2026-08-27 09:56 | pass | 2 | typecheck ✓ 2s · lint ✓ 3s · graph-store ✓ |
| 2026-08-27 09:58 | pass | 2 | typecheck ✓ 1s · lint ✓ 4s · graph-store ✓ |
| 2026-08-27 10:01 | pass | 2 | typecheck ✓ 3s · lint ✓ 12s · graph-store ✓ |
| 2026-08-27 10:08 | pass | 2 | typecheck ✓ 1s · lint ✓ 4s · graph-store ✓ |
| 2026-08-28 06:38 | pass | 3 | typecheck ✓ 2s · lint ✓ 3s · core ✓ · episodic ✓ |
| 2026-08-28 06:59 | pass | 3 | typecheck ✓ 3s · lint ✓ 4s · core ✓ · episodic ✓ |
| 2026-08-28 07:00 | pass | 3 | typecheck ✓ 4s · lint ✓ 8s · core ✓ · episodic ✓ |
| 2026-08-28 07:00 | pass | 3 | typecheck ✓ 2s · lint ✓ 2s · core ✓ · episodic ✓ |
| 2026-08-28 07:01 | pass | 3 | typecheck ✓ 3s · lint ✓ 3s · core ✓ · episodic ✓ |
| 2026-08-28 07:01 | pass | 3 | typecheck ✓ 1s · lint ✓ 2s · core ✓ · episodic ✓ |
| 2026-08-28 07:01 | pass | 3 | typecheck ✓ 1s · lint ✓ 3s · core ✓ · episodic ✓ |
| 2026-08-28 07:02 | pass | 3 | typecheck ✓ 1s · lint ✓ 1s · core ✓ · episodic ✓ |
| 2026-08-28 07:02 | pass | 3 | typecheck ✓ 2s · lint ✓ 1s · core ✓ · episodic ✓ |
| 2026-08-28 07:02 | pass | 3 | typecheck ✓ 1s · lint ✓ 2s · core ✓ · episodic ✓ |
| 2026-08-28 07:03 | pass | 3 | typecheck ✓ 1s · lint ✓ 1s · core ✓ · episodic ✓ |
| 2026-08-28 07:03 | pass | 3 | typecheck ✓ 2s · lint ✓ 2s · core ✓ · episodic ✓ |
| 2026-08-28 07:04 | pass | 3 | typecheck ✓ 1s · lint ✓ 2s · core ✓ · episodic ✓ |
| 2026-08-28 07:04 | pass | 3 | typecheck ✓ 2s · lint ✓ 2s · core ✓ · episodic ✓ |
| 2026-08-28 07:04 | pass | 3 | typecheck ✓ 1s · lint ✓ 2s · core ✓ · episodic ✓ |
| 2026-08-28 07:05 | pass | 3 | typecheck ✓ 2s · lint ✓ 2s · core ✓ · episodic ✓ |
| 2026-08-28 07:05 | pass | 3 | typecheck ✓ 2s · lint ✓ 2s · core ✓ · episodic ✓ |
| 2026-08-28 07:05 | pass | 3 | typecheck ✓ 1s · lint ✓ 2s · core ✓ · episodic ✓ |
| 2026-08-28 07:06 | pass | 3 | typecheck ✓ 1s · lint ✓ 2s · core ✓ · episodic ✓ |
| 2026-08-28 07:06 | pass | 3 | typecheck ✓ 1s · lint ✓ 2s · core ✓ · episodic ✓ |
| 2026-08-28 07:06 | pass | 3 | typecheck ✓ 1s · lint ✓ 2s · core ✓ · episodic ✓ |
| 2026-08-28 07:42 | pass | 7 | typecheck ✓ 2s · lint ✓ 2s · capture ✓ · core ✓ · episodic ✓ · graph-store ✓ |
| 2026-08-28 07:43 | pass | 7 | typecheck ✓ 3s · lint ✓ 4s · capture ✓ · core ✓ · episodic ✓ · graph-store ✓ |
| 2026-08-28 08:31 | pass | 7 | typecheck ✓ 2s · lint ✓ 2s · capture ✓ · core ✓ · episodic ✓ · graph-store ✓ |
| 2026-08-28 08:52 | pass | 7 | typecheck ✓ 1s · lint ✓ 2s · capture ✓ · core ✓ · episodic ✓ · graph-store ✓ |
| 2026-08-28 09:38 | pass | 7 | typecheck ✓ 2s · lint ✓ 2s · capture ✓ · core ✓ · episodic ✓ · graph-store ✓ |
| 2026-08-28 09:38 | pass | 7 | typecheck ✓ 2s · lint ✓ 2s · capture ✓ · core ✓ · episodic ✓ · graph-store ✓ |
| 2026-08-28 09:39 | pass | 7 | typecheck ✓ 1s · lint ✓ 2s · capture ✓ · core ✓ · episodic ✓ · graph-store ✓ |
| 2026-08-28 09:39 | pass | 7 | typecheck ✓ 1s · lint ✓ 2s · capture ✓ · core ✓ · episodic ✓ · graph-store ✓ |
| 2026-08-28 09:40 | pass | 7 | typecheck ✓ 2s · lint ✓ 2s · capture ✓ · core ✓ · episodic ✓ · graph-store ✓ |
| 2026-08-28 09:40 | pass | 7 | typecheck ✓ 1s · lint ✓ 1s · capture ✓ · core ✓ · episodic ✓ · graph-store ✓ |
| 2026-08-28 09:41 | pass | 7 | typecheck ✓ 1s · lint ✓ 2s · capture ✓ · core ✓ · episodic ✓ · graph-store ✓ |
| 2026-08-28 09:41 | pass | 7 | typecheck ✓ 2s · lint ✓ 2s · capture ✓ · core ✓ · episodic ✓ · graph-store ✓ |
| 2026-08-28 09:42 | pass | 7 | typecheck ✓ 2s · lint ✓ 2s · capture ✓ · core ✓ · episodic ✓ · graph-store ✓ |
| 2026-08-28 09:42 | pass | 7 | typecheck ✓ 2s · lint ✓ 1s · capture ✓ · core ✓ · episodic ✓ · graph-store ✓ |
| 2026-08-28 09:42 | pass | 7 | typecheck ✓ 1s · lint ✓ 2s · capture ✓ · core ✓ · episodic ✓ · graph-store ✓ |
| 2026-08-28 09:43 | pass | 7 | typecheck ✓ 2s · lint ✓ 2s · capture ✓ · core ✓ · episodic ✓ · graph-store ✓ |
| 2026-08-28 09:44 | pass | 7 | typecheck ✓ 2s · lint ✓ 2s · capture ✓ · core ✓ · episodic ✓ · graph-store ✓ |
| 2026-08-28 09:44 | pass | 7 | typecheck ✓ 1s · lint ✓ 2s · capture ✓ · core ✓ · episodic ✓ · graph-store ✓ |
| 2026-08-28 09:44 | pass | 7 | typecheck ✓ 1s · lint ✓ 2s · capture ✓ · core ✓ · episodic ✓ · graph-store ✓ |
| 2026-08-28 09:45 | pass | 7 | typecheck ✓ 1s · lint ✓ 2s · capture ✓ · core ✓ · episodic ✓ · graph-store ✓ |
| 2026-08-28 09:45 | pass | 7 | typecheck ✓ 3s · lint ✓ 5s · capture ✓ · core ✓ · episodic ✓ · graph-store ✓ |
| 2026-08-28 09:46 | pass | 7 | typecheck ✓ 2s · lint ✓ 1s · capture ✓ · core ✓ · episodic ✓ · graph-store ✓ |
| 2026-08-28 09:46 | pass | 7 | typecheck ✓ 2s · lint ✓ 1s · capture ✓ · core ✓ · episodic ✓ · graph-store ✓ |
