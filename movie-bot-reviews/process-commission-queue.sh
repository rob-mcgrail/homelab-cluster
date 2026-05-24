#!/bin/bash
# Cron: every minute, process queued commissions. The dashboard's POST
# /api/film-reviews/commission endpoint can't invoke the Claude Code
# CLI directly (the dashboard runs in a container with no `claude`
# binary), so it drops a JSON file into the queue dir and this host
# script picks them up.
#
# Add to crontab: * * * * * /path/to/process-commission-queue.sh
#
# Singleton-locked so a long-running commission can't overlap with the
# next minute's tick.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="$REPO_ROOT/movie-bot-data"
QUEUE_DIR="$DATA_DIR/.commission-queue"
LOCKFILE="$DATA_DIR/.commission-processor.lock"

mkdir -p "$QUEUE_DIR"

if [ -f "$LOCKFILE" ] && kill -0 "$(cat "$LOCKFILE")" 2>/dev/null; then
    exit 0
fi
echo $$ > "$LOCKFILE"
trap 'rm -f "$LOCKFILE"' EXIT

# Process queued commissions oldest-first.
for queue_file in $(ls -1tr "$QUEUE_DIR"/*.json 2>/dev/null); do
    title=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['title'])" "$queue_file" 2>/dev/null)
    year=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('year',''))" "$queue_file" 2>/dev/null)
    take=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['take'])" "$queue_file" 2>/dev/null)

    if [ -z "$title" ] || [ -z "$take" ]; then
        # Malformed queue file — move out of the way so we don't retry.
        mv "$queue_file" "${queue_file}.malformed"
        continue
    fi

    # Run the commission. commission-review.sh writes its own pending
    # marker and logs to completed-review-runs/.
    "$SCRIPT_DIR/commission-review.sh" "$title" "$year" "$take"

    # Whether it succeeded or failed, the queue file's job is done.
    rm -f "$queue_file"
done
