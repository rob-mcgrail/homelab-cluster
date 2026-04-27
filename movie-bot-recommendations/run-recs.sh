#!/bin/bash
# Cron job: weekly film recommendations based on the user's thoughts + prior rec feedback.
# Add to crontab: 0 6 * * 0 /path/to/homelab-cluster/movie-bot-recommendations/run-recs.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="$REPO_ROOT/movie-bot-data"
PROMPT="$SCRIPT_DIR/recs-prompt.txt"
LOGDIR="$DATA_DIR/completed-recs-runs"
LOCKFILE="$DATA_DIR/.recs.lock"

if [ -f "$LOCKFILE" ] && kill -0 "$(cat "$LOCKFILE")" 2>/dev/null; then
    exit 0
fi
echo $$ > "$LOCKFILE"
trap 'rm -f "$LOCKFILE"' EXIT

CLAUDE="$(command -v claude 2>/dev/null || echo "$HOME/.local/bin/claude")"
RECS_FILE="$DATA_DIR/recommendations.jsonl"
mkdir -p "$LOGDIR"

# Capture the recs file size before the run so we can detect whether
# claude actually appended anything new — only notify the user when
# fresh recs landed, not on every cron tick.
before=$(wc -l < "$RECS_FILE" 2>/dev/null | tr -d ' ' || echo 0)

ts=$(date -u +%Y%m%dT%H%M%SZ)
cd "$REPO_ROOT" && "$CLAUDE" --dangerously-skip-permissions -p "$(cat "$PROMPT")" \
    > "$LOGDIR/${ts}.md" 2>&1

# Retain last 20 runs, prune older
ls -1t "$LOGDIR"/*.md 2>/dev/null | tail -n +21 | xargs -r rm -f

# Push notification IFF new recs were appended. Hits the dashboard's
# /api/event endpoint via the local-loopback port binding (only
# reachable on the host, not the LAN). Token comes from .api_keys.
after=$(wc -l < "$RECS_FILE" 2>/dev/null | tr -d ' ' || echo 0)
if [ "$after" -gt "$before" ]; then
    new=$((after - before))
    # shellcheck source=/dev/null
    [ -f "$REPO_ROOT/.api_keys" ] && source "$REPO_ROOT/.api_keys"
    if [ -n "$PUSH_EVENT_TOKEN" ]; then
        curl -fsS -m 10 -X POST \
            -H "Content-Type: application/json" \
            -H "X-Push-Token: $PUSH_EVENT_TOKEN" \
            "http://localhost:8000/api/event" \
            -d "{\"title\":\"Your recs are ready\",\"body\":\"$new new pick$( [ "$new" -gt 1 ] && echo s )\",\"url\":\"/#recs\",\"tag\":\"recs\"}" \
            > /dev/null 2>&1 || true
    fi
fi
