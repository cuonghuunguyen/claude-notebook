# Quality log

One row per finished task, written by `.claude/hooks/quality-gate.sh`. The
point is early detection: a failing row here means the problem was caught at
the end of the task that caused it, not at the next milestone's CI run.

| When (UTC) | Verdict | Files | Checks |
|---|---|---|---|
| 2026-08-16 12:27 | pass | 1 | typecheck ✓ 6s · lint ✓ 3s · core ✓ |
| 2026-08-16 12:27 | FAIL | 1 | typecheck ✗ · lint ✗ · core ✓ |
| 2026-08-16 12:27 | FAIL | 1 | typecheck ✗ · lint ✗ · core ✓ |
