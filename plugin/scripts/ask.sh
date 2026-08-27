#!/usr/bin/env bash
# UserPromptSubmit: retrieve prior knowledge for the prompt and inject it as context.
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
[ -f .claude/memory.db ] || exit 0
PROMPT=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("prompt",""))' 2>/dev/null)
# ponytail: skip short prompts (slash commands, "yes", "continue") — nothing to retrieve on.
[ "${#PROMPT}" -ge 25 ] || exit 0
OUT=$(REPO_DIR="$PWD" npx -y claude-notebook ask "$PROMPT" 2>/dev/null) || exit 0
printf '%s' "$OUT" | grep -q 'prior knowledge (0)' && exit 0
printf '<claude-notebook-memory>\nRetrieved from this repo'"'"'s memory (commit reasoning + past session notes). Verify anything tagged possibly-stale.\n\n%s\n</claude-notebook-memory>\n' "$OUT"
