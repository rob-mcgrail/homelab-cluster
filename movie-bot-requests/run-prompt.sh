#!/bin/bash
# Cron job: picks up prompts from the dashboard and runs the pi coding agent
# Add to crontab: * * * * * /path/to/homelab-cluster/movie-bot-requests/run-prompt.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="$REPO_ROOT/movie-bot-data"
PENDING_DIR="$DATA_DIR/pending"
COMPLETED_DIR="$DATA_DIR/completed-requests"
PROJECT_DIR="$REPO_ROOT"
TEMPLATE="$SCRIPT_DIR/prompt-template.txt"
LOCKFILE="$DATA_DIR/.request.lock"

# Prevent duplicate runs
if [ -f "$LOCKFILE" ] && kill -0 "$(cat "$LOCKFILE")" 2>/dev/null; then
    exit 0
fi
echo $$ > "$LOCKFILE"
trap 'rm -f "$LOCKFILE"' EXIT

# Find pi binary (nvm-managed, so not on cron's PATH — fall back to the
# highest-versioned node bin)
PI="$(command -v pi 2>/dev/null || ls -1 "$HOME"/.nvm/versions/node/*/bin/pi 2>/dev/null | sort -V | tail -n1)"

mkdir -p "$COMPLETED_DIR"

for f in "$PENDING_DIR"/*.txt; do
    [ -f "$f" ] || continue

    base=$(basename "$f" .txt)
    user_prompt=$(cat "$f")

    # Build the full prompt from template (parameter expansion handles multi-line user prompts safely)
    full_prompt=$(<"$TEMPLATE")
    full_prompt="${full_prompt//\{\{PROMPT\}\}/$user_prompt}"

    # Run pi on deepseek-v4-flash — this job is mechanical arr-stack
    # management (search title, pick profile, add to Sonarr/Radarr,
    # trigger search). Doesn't need v4-pro's deeper judgment.
    cd "$PROJECT_DIR" && "$PI" --provider openrouter --model deepseek/deepseek-v4-flash --thinking high -a -p "$full_prompt" \
        > "$COMPLETED_DIR/${base}.out" 2>&1

    # Move processed prompt
    mv "$f" "$COMPLETED_DIR/${base}.txt"
done
