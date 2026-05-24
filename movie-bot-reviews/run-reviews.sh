#!/bin/bash
# Cron job: nightly deep-lore film-criticism review of one unseen Jellyfin film.
#
# The film is rolled by THIS script (not the bot) so that selection is a true
# uniform random draw across the unseen, un-reviewed catalogue rather than
# whatever the model happens to gravitate toward. The bot is then handed the
# chosen film and writes the review against it.
#
# Add to crontab: 0 4 * * * /path/to/homelab-cluster/movie-bot-reviews/run-reviews.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="$REPO_ROOT/movie-bot-data"
REVIEWS_DIR="$DATA_DIR/reviews"
LOGDIR="$DATA_DIR/completed-review-runs"
PROMPT="$SCRIPT_DIR/review-prompt.txt"
LOCKFILE="$DATA_DIR/.reviews.lock"

mkdir -p "$REVIEWS_DIR" "$LOGDIR"

if [ -f "$LOCKFILE" ] && kill -0 "$(cat "$LOCKFILE")" 2>/dev/null; then
    exit 0
fi
echo $$ > "$LOCKFILE"
trap 'rm -f "$LOCKFILE"' EXIT

# shellcheck disable=SC1091
source "$REPO_ROOT/.api_keys"

ts=$(date -u +%Y%m%dT%H%M%SZ)
runlog="$LOGDIR/${ts}.md"

log() { echo "$@" | tee -a "$runlog" >&2; }

# --- 1. Roll a random unseen, un-reviewed film from Jellyfin "Films" ---

USER_ID=$(curl -fsS -H "X-MediaBrowser-Token: $JELLYFIN_API_KEY" \
    "$JELLYFIN_URL/Users" | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['Id'])")
LIB_ID=$(curl -fsS -H "X-MediaBrowser-Token: $JELLYFIN_API_KEY" \
    "$JELLYFIN_URL/Users/$USER_ID/Views" | python3 -c "
import json, sys
for v in json.load(sys.stdin).get('Items', []):
    if v.get('Name') == 'Films':
        print(v['Id']); break
")

if [ -z "$USER_ID" ] || [ -z "$LIB_ID" ]; then
    log "ERROR: could not resolve Jellyfin user / Films library"
    exit 1
fi

# Set of Jellyfin IDs we've already reviewed — extracted from frontmatter
already_reviewed_file=$(mktemp)
trap 'rm -f "$LOCKFILE" "$already_reviewed_file"' EXIT
grep -h '^jellyfinId:' "$REVIEWS_DIR"/*.md 2>/dev/null \
    | awk '{print $2}' \
    | sort -u > "$already_reviewed_file"

PICK=$(curl -fsS -H "X-MediaBrowser-Token: $JELLYFIN_API_KEY" \
    "$JELLYFIN_URL/Users/$USER_ID/Items?ParentId=$LIB_ID&IncludeItemTypes=Movie&Recursive=true&Fields=UserData,ProductionYear&Limit=5000" \
    | python3 -c "
import json, sys, random
seen = set(l.strip() for l in open('$already_reviewed_file') if l.strip())
items = json.load(sys.stdin).get('Items', [])
candidates = [
    i for i in items
    if not i.get('UserData', {}).get('Played', False)
    and i['Id'] not in seen
]
if not candidates:
    print('NONE'); sys.exit(0)
p = random.choice(candidates)
print(f\"{p['Id']}\t{p.get('Name','')}\t{p.get('ProductionYear','')}\")")

if [ "$PICK" = "NONE" ] || [ -z "$PICK" ]; then
    log "no unseen, un-reviewed films available — no-op"
    exit 0
fi

FILM_ID=$(printf '%s' "$PICK" | cut -f1)
FILM_TITLE=$(printf '%s' "$PICK" | cut -f2)
FILM_YEAR=$(printf '%s' "$PICK" | cut -f3)

log "rolled: $FILM_TITLE ($FILM_YEAR) [$FILM_ID]"

# --- 2. Build prompt body with film context appended ---

prompt_body="$(cat "$PROMPT")

---

The film you are reviewing tonight has been randomly drawn from the
unseen, un-reviewed Films library. You did not pick it; the shell did.
Write the review for THIS film, even if it isn't a film you'd have
chosen. Engage with what's actually there.

  title:       $FILM_TITLE
  year:        $FILM_YEAR
  jellyfinId:  $FILM_ID
  runId:       $ts
"

# --- 3. Invoke Claude Code with the augmented prompt ---

CLAUDE="$(command -v claude 2>/dev/null || echo "$HOME/.local/bin/claude")"

cd "$REPO_ROOT" && "$CLAUDE" --dangerously-skip-permissions -p "$prompt_body" \
    >> "$runlog" 2>&1

# --- 4. Retain last 20 run reports ---
ls -1t "$LOGDIR"/*.md 2>/dev/null | tail -n +21 | xargs -r rm -f
