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
