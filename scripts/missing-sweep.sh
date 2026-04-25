#!/bin/bash
# Daily cron: search for monitored items that have no file yet.
#   - Sonarr MissingEpisodeSearch
#   - Radarr MissingMoviesSearch
#
# These are gaps — episodes not downloaded, movies not acquired — where
# the arr service knows it should have a file but doesn't. Worth
# checking daily because new releases appear and it's how we fill
# back-catalog holes for recently-monitored series.
#
# Add to crontab:
#   0 4 * * * /path/to/homelab-cluster/scripts/missing-sweep.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOGDIR="$REPO_ROOT/movie-bot-data/sweep-logs"
mkdir -p "$LOGDIR"

source "$REPO_ROOT/.api_keys"

ts=$(date -u +%Y%m%dT%H%M%SZ)
LOG="$LOGDIR/missing-${ts}.log"

{
  echo "=== $ts missing-sweep ==="
  echo
  echo "-- Sonarr: MissingEpisodeSearch --"
  curl -fsS -X POST -H "X-Api-Key: $SONARR_API_KEY" -H "Content-Type: application/json" \
    "$SONARR_URL/api/v3/command" -d '{"name":"MissingEpisodeSearch"}' || echo "FAILED"
  echo; echo
  echo "-- Radarr: MissingMoviesSearch --"
  curl -fsS -X POST -H "X-Api-Key: $RADARR_API_KEY" -H "Content-Type: application/json" \
    "$RADARR_URL/api/v3/command" -d '{"name":"MissingMoviesSearch"}' || echo "FAILED"
  echo
} > "$LOG" 2>&1

ls -1t "$LOGDIR"/missing-*.log 2>/dev/null | tail -n +31 | xargs -r rm -f
