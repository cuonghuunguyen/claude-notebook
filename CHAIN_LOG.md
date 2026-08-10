# Chain Log

Append-only. One line per cycle of `/next-milestone`, `/propose-milestone`,
or `/self-improve` — whichever ran. This is what the circuit breaker (see
`CLAUDE.md`) reads before spawning a successor: it exists so an unproductive
loop of "nothing found" cycles has a place to be *counted*, not just
reported and forgotten each time in a session nobody's watching.

Format: `<UTC timestamp> | <skill> | <outcome> | <PR link or reason>`

Outcomes: `shipped` (a milestone/proposal/improvement merged),
`nothing-found` (self-improve surveyed, found no candidate),
`nothing-to-propose` (propose-milestone researched, found no candidate),
`left-open` (a PR left open for a human — deviation or unmet evidence bar;
the chain already stops here regardless of this log, per each skill's own
step 14/15/10-11 rule — logged for the historical record, not because the
circuit breaker needs it).

Never edit or delete a past line.

---

2026-08-10T04:23:23Z | propose-milestone | shipped | proposal M8: Multi-Language Structural Extraction — PR #9 (merged by human review, not self-merged — evidence bar was cleanly met but building it requires a new stack dependency, so it was left open per the skill's own non-negotiable; the human approved and merged it)
2026-08-10T04:51:33Z | next-milestone | shipped | M8: Multi-Language Structural Extraction (Python via tree-sitter) — PR #13
