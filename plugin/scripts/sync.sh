#!/usr/bin/env bash
# SessionStart: mine new explanatory commits into <repo>/.claude/memory.db. Idempotent.
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0
grep -qs 'memory.db' .gitignore || printf '.claude/memory.db*\n.claude/scout-report.json\n' >> .gitignore
OUT=$(${CLAUDE_NOTEBOOK_BIN:-npx -y claude-notebook} sync 2>&1) || exit 0
N=$(printf '%s' "$OUT" | grep -o '"explanatoryCommits": *[0-9]*' | grep -o '[0-9]*$')
S=$(${CLAUDE_NOTEBOOK_BIN:-npx -y claude-notebook} stats 2>/dev/null | grep -o '"experiences": *[0-9]*' | grep -o '[0-9]*$')
printf 'claude-notebook: memory synced (%s memories, %s explanatory commits in history). Ask it with `claude-notebook ask "why ...?"` before touching unfamiliar code.\n' "${S:-?}" "${N:-?}"
