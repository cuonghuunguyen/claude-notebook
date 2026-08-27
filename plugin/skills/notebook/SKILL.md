---
name: notebook
description: Query and grow this repository's claude-notebook memory — the reasoning behind the code, mined from explanatory commits and past sessions' notes. Use when asked "why is X like this", "was Y tried before", "what does this repo remember", or `/notebook <question>`; and at the end of any task where you worked out how something non-obvious fits together, to write a scout report so the next session does not re-derive it.
---

# notebook

`claude-notebook` is a CLI (`npx -y claude-notebook <cmd>`). Memory lives in
`<repo>/.claude/memory.db`. The plugin's hooks already run `sync` at session
start and inject `ask` results for substantial prompts; this skill is for
doing it deliberately.

## Ask

```bash
npx -y claude-notebook ask "<question in plain words — why, what broke, what was tried>"
```

Read the whole "Why / prior knowledge" block. A hit tagged
`possibly-stale — verify before trusting` is still returned on purpose: a file
it anchors to changed since, which is a warning, not a verdict. Check the code
before relying on it; settle it with `/refine-memory <id>` if you did the
checking anyway.

`(0)` hits = the memory has nothing on this. Fall back to `git log`, and
consider writing a scout report when you are done.

## Write back (scout report)

When a task made you understand *how or why* something fits together — not
*where* it is (grep answers that) — write before finishing:

```json
// .claude/scout-report.json
{
  "task": "<what you were doing, one line>",
  "understanding": "<synthesized reasoning: what depends on what, why the odd part is there, what breaks if changed>",
  "anchors": ["path/to/file.ts", "path/to/other.py"]
}
```

The Stop hook records it and deletes the file. A report that is only a file
listing is rejected.

## Maintenance

```bash
npx -y claude-notebook stats       # corpus size, tiers, flagged count
npx -y claude-notebook suspects    # flagged memories, oldest first
npx -y claude-notebook stale       # re-run the staleness pass
```

`sync` only keeps commits whose body (≥200 chars) explains *why*. If `stats`
shows few memories, the fix is in the repo's commit messages, not here.
