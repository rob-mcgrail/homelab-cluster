#!/bin/bash
# Weekly cron: search for monitored items that have a file but it's below
# the quality profile's cutoff.
#   - Sonarr CutoffUnmetEpisodeSearch
#   - Radarr CutoffUnmetMoviesSearch
#
# Weekly because backlog upgrades materialise slowly — a new 1080p
# BluRay remaster of a 1970s doc isn't dropping daily. Running this
# more often is load for minimal signal.
#
# Add to crontab:
#   0 5 * * 1 /path/to/homelab-cluster/scripts/cutoff-sweep.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOGDIR="$REPO_ROOT/movie-bot-data/sweep-logs"
mkdir -p "$LOGDIR"

source "$REPO_ROOT/.api_keys"

ts=$(date -u +%Y%m%dT%H%M%SZ)
LOG="$LOGDIR/cutoff-${ts}.log"

{
  echo "=== $ts cutoff-sweep ==="
  echo
  echo "-- Sonarr: CutoffUnmetEpisodeSearch --"
  curl -fsS -X POST -H "X-Api-Key: $SONARR_API_KEY" -H "Content-Type: application/json" \
    "$SONARR_URL/api/v3/command" -d '{"name":"CutoffUnmetEpisodeSearch"}' || echo "FAILED"
  echo; echo
  echo "-- Radarr: CutoffUnmetMoviesSearch --"
  curl -fsS -X POST -H "X-Api-Key: $RADARR_API_KEY" -H "Content-Type: application/json" \
    "$RADARR_URL/api/v3/command" -d '{"name":"CutoffUnmetMoviesSearch"}' || echo "FAILED"
  echo
} > "$LOG" 2>&1

ls -1t "$LOGDIR"/cutoff-*.log 2>/dev/null | tail -n +8 | xargs -r rm -f
