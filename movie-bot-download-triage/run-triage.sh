#!/bin/bash
# Cron job: daily torrent queue triage.
# Add to crontab: 0 2 * * * /path/to/homelab-cluster/movie-bot-download-triage/run-triage.sh
# (Runs at 02:00 — before missing-sweep at 04:00 so cleanup happens
# before sweeps go looking for replacements.)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="$REPO_ROOT/movie-bot-data"
PROMPT="$SCRIPT_DIR/triage-prompt.txt"
LOGDIR="$DATA_DIR/completed-triage-runs"
LOCKFILE="$DATA_DIR/.triage.lock"

# Prevent overlap with a previous run
if [ -f "$LOCKFILE" ] && kill -0 "$(cat "$LOCKFILE")" 2>/dev/null; then
    exit 0
fi
echo $$ > "$LOCKFILE"
trap 'rm -f "$LOCKFILE"' EXIT

# pi binary (nvm-managed, so not on cron's PATH — fall back to the
# highest-versioned node bin)
PI="$(command -v pi 2>/dev/null || ls -1 "$HOME"/.nvm/versions/node/*/bin/pi 2>/dev/null | sort -V | tail -n1)"
mkdir -p "$LOGDIR"

ts=$(date -u +%Y%m%dT%H%M%SZ)
# deepseek-v4-flash for triage — it's a mechanical pass over the qBit
# queue applying decision rules from triage-prompt.txt; doesn't need
# v4-pro's stronger judgment.
cd "$REPO_ROOT" && "$PI" --provider openrouter --model deepseek/deepseek-v4-flash --thinking high -a -p "$(cat "$PROMPT")" \
    > "$LOGDIR/${ts}.md" 2>&1

# Retain last 30 runs, prune older
ls -1t "$LOGDIR"/*.md 2>/dev/null | tail -n +31 | xargs -r rm -f
