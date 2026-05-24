#!/bin/bash
# Commissioned review. Runs the same writer+revision two-pass flow as
# the nightly cron, but takes the film title + optional year + an
# editor's take from the dashboard's commission form instead of rolling
# random. The film need NOT exist in the Jellyfin library — commissions
# can be for films the user wants to talk about regardless of ownership.
#
# Usage:
#   commission-review.sh "Title" "Year-or-blank" "the take prose"
#
# Spawned detached from the dashboard's POST /api/film-reviews/commission.

set -u

if [ "$#" -lt 3 ]; then
    echo "usage: $0 TITLE YEAR-OR-BLANK TAKE" >&2
    exit 1
fi
FILM_TITLE="$1"
FILM_YEAR="$2"
TAKE="$3"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="$REPO_ROOT/movie-bot-data"
REVIEWS_DIR="$DATA_DIR/reviews"
DRAFTS_DIR="$DATA_DIR/.review-drafts"
PENDING_DIR="$DATA_DIR/.review-pending"
LOGDIR="$DATA_DIR/completed-review-runs"
HOUSE_STYLE="$SCRIPT_DIR/house-style.txt"
WRITER_PROMPT="$SCRIPT_DIR/writer-prompt.txt"
REVISION_PROMPT="$SCRIPT_DIR/revision-prompt.txt"
COMMISSION_SUPPLEMENT="$SCRIPT_DIR/commission-supplement.txt"

mkdir -p "$REVIEWS_DIR" "$DRAFTS_DIR" "$PENDING_DIR" "$LOGDIR"

# shellcheck disable=SC1091
source "$REPO_ROOT/.api_keys"

ts=$(date -u +%Y%m%dT%H%M%SZ)
slug=$(printf '%s-%s' "$FILM_TITLE" "${FILM_YEAR:-x}" \
    | tr '[:upper:]' '[:lower:]' \
    | sed 's/[^a-z0-9]/-/g; s/--*/-/g; s/^-//; s/-$//')

DRAFT_PATH="$DRAFTS_DIR/${slug}-${ts}.draft.md"
FINAL_PATH="$REVIEWS_DIR/${slug}-${ts}.md"
PENDING_PATH="$PENDING_DIR/${slug}-${ts}.json"
RUNLOG="$LOGDIR/${ts}-commission.md"

# Pending marker — so the panel can show "in flight" before the file
# itself shows up. Removed in the EXIT trap.
python3 -c "
import json, sys
print(json.dumps({
  'slug': sys.argv[1],
  'runId': sys.argv[2],
  'title': sys.argv[3],
  'year': sys.argv[4],
  'take': sys.argv[5],
  'createdAt': sys.argv[6],
  'kind': 'commission',
}))" "$slug" "$ts" "$FILM_TITLE" "$FILM_YEAR" "$TAKE" "$(date -u +%FT%TZ)" \
    > "$PENDING_PATH"
trap 'rm -f "$PENDING_PATH" "$DRAFT_PATH"' EXIT

log() { echo "$@" | tee -a "$RUNLOG" >&2; }

log "commission: $FILM_TITLE ($FILM_YEAR) — slug=$slug runId=$ts"
log "take: $TAKE"

CLAUDE="$(command -v claude 2>/dev/null || echo "$HOME/.local/bin/claude")"

# --- Writer pass ---
writer_body="$(cat "$HOUSE_STYLE")

$(cat "$WRITER_PROMPT")

$(cat "$COMMISSION_SUPPLEMENT")

---

  title:       $FILM_TITLE
  year:        $FILM_YEAR
  jellyfinId:
  runId:       $ts
  slug:        $slug
  draft path:  $DRAFT_PATH

The commission's take, verbatim from the editor:

\"\"\"
$TAKE
\"\"\"

Write your draft to draft path above. Use the slug + runId verbatim
in the frontmatter \`id\` field. Leave jellyfinId blank in the
frontmatter if not known.
"

log "=== writer pass starting $(date -u +%FT%TZ) ==="
{
    echo "=== WRITER PASS ==="
    cd "$REPO_ROOT" && "$CLAUDE" --dangerously-skip-permissions -p "$writer_body"
} >> "$RUNLOG" 2>&1

if [ ! -f "$DRAFT_PATH" ]; then
    log "ERROR: writer produced no draft at $DRAFT_PATH"
    exit 1
fi
log "=== writer pass done $(date -u +%FT%TZ), draft $(wc -c < "$DRAFT_PATH") bytes ==="

# --- Revision pass ---
revision_body="$(cat "$HOUSE_STYLE")

$(cat "$REVISION_PROMPT")

---

This review was a commission. The editor's take is below; check that
the draft actually engaged with it (agreed, disagreed, or pushed
past — but did not ignore). If the draft ignored the commission
brief, that is the kind of issue you, on your cold read, would
notice and fix.

The editor's take, verbatim:

\"\"\"
$TAKE
\"\"\"

---

The film:
  title:       $FILM_TITLE
  year:        $FILM_YEAR
  runId:       $ts

  draft path:  $DRAFT_PATH
  final path:  $FINAL_PATH

Read the draft, do the cold-read revision (including writing the
blurb), write the final to the final path, delete the draft.
"

log "=== revision pass starting $(date -u +%FT%TZ) ==="
{
    echo
    echo "=== REVISION PASS ==="
    cd "$REPO_ROOT" && "$CLAUDE" --dangerously-skip-permissions -p "$revision_body"
} >> "$RUNLOG" 2>&1

if [ ! -f "$FINAL_PATH" ]; then
    log "ERROR: revision pass produced no final at $FINAL_PATH"
    exit 1
fi
log "=== revision pass done $(date -u +%FT%TZ), final $(wc -c < "$FINAL_PATH") bytes ==="

# Retain last 20 run reports
ls -1t "$LOGDIR"/*.md 2>/dev/null | tail -n +21 | xargs -r rm -f
