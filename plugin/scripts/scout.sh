#!/usr/bin/env bash
# Stop: persist .claude/scout-report.json into memory, then clear it.
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
R=.claude/scout-report.json
[ -f "$R" ] || exit 0
if OUT=$(npx -y claude-notebook scout "$R" 2>&1); then
  rm -f "$R"
  printf '{"systemMessage":"claude-notebook: scout report recorded."}\n'
else
  printf '{"systemMessage":"claude-notebook: scout report NOT recorded (left at %s): %s"}\n' "$R" "$(printf '%s' "$OUT" | tail -1 | tr -d '"\\')"
fi
exit 0
