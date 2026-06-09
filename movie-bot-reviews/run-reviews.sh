#!/bin/bash
# Cron job: nightly deep-lore film-criticism review of one Jellyfin film.
#
# The film is rolled by THIS script (not the bot) so that selection is a true
# uniform random draw across the full Films library rather than whatever the
# model happens to gravitate toward. Both seen and unseen films are eligible.
# The bot is then handed the chosen film and writes the review against it.
#
# Re-picks are allowed by design: the RNG can land on the same film any number
# of times across nights. Each review is written from scratch with no
# awareness of prior reviews of the same film — the bot doesn't know they
# exist and shouldn't.
#
# The bot runs in two passes:
#   1. Writer pass — drafts to movie-bot-data/.review-drafts/<slug>-<runId>.draft.md
#   2. Revision pass — fresh pi session, reads the draft cold, rewrites
#      ruthlessly, writes the final to movie-bot-data/reviews/, deletes the draft.
# The revision pass is framed as the same author returning to their own work,
# not as a separate editor — gives full prose authority without anxiety about
# overstepping.
#
# Add to crontab: 0 4 * * 1 /path/to/homelab-cluster/movie-bot-reviews/run-reviews.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="$REPO_ROOT/movie-bot-data"
REVIEWS_DIR="$DATA_DIR/reviews"
DRAFTS_DIR="$DATA_DIR/.review-drafts"
LOGDIR="$DATA_DIR/completed-review-runs"
HOUSE_STYLE="$SCRIPT_DIR/house-style.txt"
WRITER_PROMPT="$SCRIPT_DIR/writer-prompt.txt"
REVISION_PROMPT="$SCRIPT_DIR/revision-prompt.txt"
LOCKFILE="$DATA_DIR/.reviews.lock"

mkdir -p "$REVIEWS_DIR" "$DRAFTS_DIR" "$LOGDIR"

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

# --- 1. Roll a random film from Jellyfin "Films" ---

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

PICK=$(curl -fsS -H "X-MediaBrowser-Token: $JELLYFIN_API_KEY" \
    "$JELLYFIN_URL/Users/$USER_ID/Items?ParentId=$LIB_ID&IncludeItemTypes=Movie&Recursive=true&Fields=ProductionYear&Limit=5000" \
    | python3 -c "
import json, sys, random
items = json.load(sys.stdin).get('Items', [])
if not items:
    print('NONE'); sys.exit(0)
p = random.choice(items)
print(f\"{p['Id']}\t{p.get('Name','')}\t{p.get('ProductionYear','')}\")")

if [ "$PICK" = "NONE" ] || [ -z "$PICK" ]; then
    log "library is empty — no-op"
    exit 0
fi

FILM_ID=$(printf '%s' "$PICK" | cut -f1)
FILM_TITLE=$(printf '%s' "$PICK" | cut -f2)
FILM_YEAR=$(printf '%s' "$PICK" | cut -f3)

# Slug — same algo the bot would use, computed here so the shell can
# hand both passes a predictable file path.
SLUG=$(printf '%s-%s' "$FILM_TITLE" "$FILM_YEAR" \
    | tr '[:upper:]' '[:lower:]' \
    | sed 's/[^a-z0-9]/-/g; s/--*/-/g; s/^-//; s/-$//')
DRAFT_PATH="$DRAFTS_DIR/${SLUG}-${ts}.draft.md"
FINAL_PATH="$REVIEWS_DIR/${SLUG}-${ts}.md"

log "rolled: $FILM_TITLE ($FILM_YEAR) [$FILM_ID]"
log "slug: $SLUG"
log "draft path: $DRAFT_PATH"
log "final path: $FINAL_PATH"

# pi binary (nvm-managed, so not on cron's PATH — fall back to the
# highest-versioned node bin)
PI="$(command -v pi 2>/dev/null || ls -1 "$HOME"/.nvm/versions/node/*/bin/pi 2>/dev/null | sort -V | tail -n1)"

# deepseek-v4-pro on both passes — film criticism is the bot's most
# judgment- and prose-heavy job, so it gets the stronger model.
PI_ARGS=(--provider openrouter --model deepseek/deepseek-v4-pro --thinking high -a)

# --- 2. Writer pass ---

writer_body="$(cat "$HOUSE_STYLE")

$(cat "$WRITER_PROMPT")

---

The film you are reviewing tonight has been randomly drawn from the
full Films library. You did not pick it; the shell did. The user may
or may not have seen it before. Write the review for THIS film, even
if it isn't a film you'd have chosen.

  title:       $FILM_TITLE
  year:        $FILM_YEAR
  jellyfinId:  $FILM_ID
  runId:       $ts
  slug:        $SLUG
  draft path:  $DRAFT_PATH

Write your draft to draft path above. The slug + runId are fixed;
use them verbatim in the frontmatter \`id\` field. Do NOT write to
the reviews directory — that's the revision pass's job.
"

log "=== writer pass starting $(date -u +%FT%TZ) ==="
{
    echo "=== WRITER PASS ==="
    cd "$REPO_ROOT" && "$PI" "${PI_ARGS[@]}" -p "$writer_body"
} >> "$runlog" 2>&1

if [ ! -f "$DRAFT_PATH" ]; then
    log "ERROR: writer did not produce draft at $DRAFT_PATH"
    exit 1
fi
log "=== writer pass done $(date -u +%FT%TZ), draft $(wc -c < "$DRAFT_PATH") bytes ==="

# --- 3. Revision pass (fresh pi session, cold read) ---

revision_body="$(cat "$HOUSE_STYLE")

$(cat "$REVISION_PROMPT")

---

The film:
  title:       $FILM_TITLE
  year:        $FILM_YEAR
  jellyfinId:  $FILM_ID
  runId:       $ts

  draft path:  $DRAFT_PATH
  final path:  $FINAL_PATH

Read the draft, do the cold-read revision, write the final to the
final path, delete the draft.
"

log "=== revision pass starting $(date -u +%FT%TZ) ==="
{
    echo
    echo "=== REVISION PASS ==="
    cd "$REPO_ROOT" && "$PI" "${PI_ARGS[@]}" -p "$revision_body"
} >> "$runlog" 2>&1

if [ ! -f "$FINAL_PATH" ]; then
    log "ERROR: revision pass did not produce final at $FINAL_PATH"
    exit 1
fi
log "=== revision pass done $(date -u +%FT%TZ), final $(wc -c < "$FINAL_PATH") bytes ==="

# Clean up any stale draft if the revision pass forgot to delete it
rm -f "$DRAFT_PATH"

# --- 4. Retain last 20 run reports ---
ls -1t "$LOGDIR"/*.md 2>/dev/null | tail -n +21 | xargs -r rm -f
