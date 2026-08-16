#!/bin/bash
# Fast feedback right after a TypeScript edit (PostToolUse hook).
#
# Typechecks only the package the edited file belongs to, and reports through
# additionalContext rather than blocking: mid-refactor an intermediate state is
# legitimately broken, so a hard block here would fight the agent instead of
# helping it. The Stop gate is the one that blocks.
set -uo pipefail

cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}" || exit 0

FILE=$(cat | python3 -c \
  'import json,sys
try:
    d = json.load(sys.stdin)
    print(d.get("tool_input", {}).get("file_path") or d.get("tool_response", {}).get("filePath") or "")
except Exception:
    print("")' 2>/dev/null)

case "$FILE" in
  *.ts) ;;
  *) exit 0 ;;
esac

# Nearest ancestor package with a typecheck script.
DIR=$(dirname "$FILE")
PKG=""
while [ "$DIR" != "/" ] && [ "$DIR" != "." ]; do
  if [ -f "$DIR/package.json" ] && grep -q '"typecheck"' "$DIR/package.json"; then
    PKG="$DIR"
    break
  fi
  DIR=$(dirname "$DIR")
done
[ -z "$PKG" ] && exit 0

OUTPUT=$(cd "$PKG" && pnpm typecheck 2>&1)
[ $? -eq 0 ] && exit 0

python3 -c "
import json, sys
errors = sys.stdin.read()
lines = [l for l in errors.splitlines() if 'error TS' in l][:8]
if not lines:
    sys.exit(0)
print(json.dumps({
    'hookSpecificOutput': {
        'hookEventName': 'PostToolUse',
        'additionalContext': 'Typecheck of $PKG is failing after this edit:\n' + '\n'.join(lines) +
                             '\n(Expected mid-refactor; the Stop hook gates the finished task.)',
    }
}))
" <<< "$OUTPUT"
exit 0
