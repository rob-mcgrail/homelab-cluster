#!/bin/bash
# Cron job: picks up prompts from the dashboard and runs Claude Code
# Add to crontab: * * * * * /path/to/homelab-cluster/dashboard/cron/run-prompt.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROMPTS_DIR="$REPO_ROOT/prompts"
PROJECT_DIR="$REPO_ROOT"
TEMPLATE="$SCRIPT_DIR/prompt-template.txt"
LOCKFILE="$PROMPTS_DIR/.lock"

# Prevent duplicate runs
if [ -f "$LOCKFILE" ] && kill -0 "$(cat "$LOCKFILE")" 2>/dev/null; then
    exit 0
fi
echo $$ > "$LOCKFILE"
trap 'rm -f "$LOCKFILE"' EXIT

# Find claude binary
CLAUDE="$(command -v claude 2>/dev/null || echo "$HOME/.local/bin/claude")"

mkdir -p "$PROMPTS_DIR/done"

for f in "$PROMPTS_DIR"/*.txt; do
    [ -f "$f" ] || continue

    base=$(basename "$f" .txt)
    user_prompt=$(cat "$f")

    # Build the full prompt from template (parameter expansion handles multi-line user prompts safely)
    full_prompt=$(<"$TEMPLATE")
    full_prompt="${full_prompt//\{\{PROMPT\}\}/$user_prompt}"

    # Run Claude Code
    cd "$PROJECT_DIR" && "$CLAUDE" --dangerously-skip-permissions -p "$full_prompt" \
        > "$PROMPTS_DIR/done/${base}.out" 2>&1

    # Move processed prompt
    mv "$f" "$PROMPTS_DIR/done/${base}.txt"
done
