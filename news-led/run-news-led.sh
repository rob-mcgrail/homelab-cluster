#!/bin/bash
# Ambient LED news curator — occasionally surfaces one genuinely-interesting
# news headline on the LCD. Runs from cron every 5 min; each run:
#   1. only proceeds during Rob's waking hours (NZ local, DST-aware)
#   2. randomly gates itself so it fires ~4/hour on average
#   3. fetches RSS headlines; a pi (LLM) call curates ONE crisp <=64-char
#      line, and is allowed to return SKIP if nothing clears the bar
#   The LED colours every message with the CURRENT TARIFF BAND (esp-tou v7+):
#   the payload sends no colour, so the device uses green/amber/red itself.
#   4. posts LED-only (push:false) to the dashboard's /api/event, which is
#      the sole egress to the device
#
# Flags (for manual testing): --now (skip time+rate gates), --dry (print,
# don't post).
#
# Cron: */5 * * * * /home/rob/homelab-cluster/news-led/run-news-led.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
STATE_DIR="$SCRIPT_DIR/state"
RECENT="$STATE_DIR/recent.jsonl"
LOGFILE="$STATE_DIR/run.log"
LOCK="$STATE_DIR/.lock"
mkdir -p "$STATE_DIR"

# ---- config -----------------------------------------------------------------
WAKE_START=7            # NZ local hour: start of waking window (inclusive)
WAKE_END=23            # NZ local hour: end of waking window (exclusive)
ATTEMPTS_PER_HOUR=12   # cron fires every 5 min => 12 attempts/hour
TARGET_SHOWS_PER_HOUR=4 # aim ~4 shown/hour (recycling allowed — see prompt)
NEWS_TTL=25            # seconds the LED holds a news line
# Colour is not set here — the LED shows each message in the current tariff-band
# colour (green/amber/red), because the payload sends no colour (esp-tou v7+).
MODEL="deepseek/deepseek-v4-flash"

# Feeds: "Label|url". Topics: world, NZ, tech, business.
FEEDS=(
  "World|https://feeds.bbci.co.uk/news/world/rss.xml"
  "World|https://www.theguardian.com/world/rss"
  "NZ|https://www.rnz.co.nz/rss/national.xml"
  "Tech|https://feeds.arstechnica.com/arstechnica/index"
  "Tech|https://hnrss.org/frontpage"
  "Business|https://feeds.bbci.co.uk/news/business/rss.xml"
)

# ---- flags ------------------------------------------------------------------
FORCE=0; DRY=0
for a in "$@"; do
  case "$a" in
    --now)   FORCE=1 ;;
    --dry)   DRY=1 ;;
  esac
done

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$LOGFILE"; }

# ---- gates ------------------------------------------------------------------
nzhour=$(TZ="Pacific/Auckland" date +%-H)
nzdate=$(TZ="Pacific/Auckland" date +%F)

if [ "$FORCE" != "1" ]; then
  if [ "$nzhour" -lt "$WAKE_START" ] || [ "$nzhour" -ge "$WAKE_END" ]; then
    exit 0   # outside waking hours
  fi
  fire_pct=$(( 100 * TARGET_SHOWS_PER_HOUR / ATTEMPTS_PER_HOUR ))
  (( RANDOM % 100 < fire_pct )) || exit 0   # rate gate
fi

# Single-flight: never overlap a previous (slow LLM) run.
if [ -f "$LOCK" ] && kill -0 "$(cat "$LOCK" 2>/dev/null)" 2>/dev/null; then
  exit 0
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT

# Single mode now (quotes were dropped Oct 2026); MODE stays in the log lines
# and recent.jsonl rows so older history keeps parsing the same way.
MODE="news"

# Recently-shown lines of the same mode, for the "don't repeat" context.
recent_block() {
  local mode="$1" n="$2"
  [ -f "$RECENT" ] || return 0
  MODE="$mode" N="$n" python3 -c '
import os, sys, json
mode = os.environ["MODE"]; n = int(os.environ["N"])
rows = []
for line in open(sys.argv[1]):
    line = line.strip()
    if not line:
        continue
    try:
        d = json.loads(line)
    except Exception:
        continue
    if d.get("mode") == mode:
        t = d.get("text", "")
        if t:
            rows.append("- " + t)
print("\n".join(rows[-n:]))
' "$RECENT"
}

# ---- resolve pi (nvm-managed, not on cron PATH) -----------------------------
PI="$(command -v pi 2>/dev/null || ls -1 "$HOME"/.nvm/versions/node/*/bin/pi 2>/dev/null | sort -V | tail -n1)"
if [ -z "$PI" ]; then log "no pi binary found"; exit 0; fi

# ---- build prompt -----------------------------------------------------------
RECENT_TXT="$(recent_block news 40)"
HEADLINES="$(python3 "$SCRIPT_DIR/fetch-headlines.py" "${FEEDS[@]}")"
if [ -z "$HEADLINES" ]; then log "news: no headlines fetched"; exit 0; fi
TEMPLATE="$SCRIPT_DIR/news-prompt.txt"
TTL="$NEWS_TTL"

PROMPT="$(RECENT="$RECENT_TXT" HEADLINES="$HEADLINES" python3 -c '
import os, sys
t = open(sys.argv[1]).read()
t = t.replace("{{RECENT}}", os.environ.get("RECENT", "") or "(none yet)")
t = t.replace("{{HEADLINES}}", os.environ.get("HEADLINES", ""))
print(t)
' "$TEMPLATE")"

# ---- run the model ----------------------------------------------------------
# Retry once if the model (a) overruns the 64-char display — a clipped
# headline reads worse than a shorter one — or (b) returns an
# empty/unparseable response (an occasional transient blip); the retry note
# tells it what went wrong. A legitimate SKIP is respected immediately.
line=""; extra=""
for attempt in 1 2; do
  P="$PROMPT"
  [ -n "$extra" ] && P="$PROMPT

$extra"
  # --no-tools: this is pure text-in/text-out curation. pi has no web tool
  # anyway, and disabling its local bash/edit/write tools means the run can't
  # touch the repo it's launched in — it can only return the RESULT/COLOUR text.
  #
  # Write stdout to a temp FILE, not a $(...) pipe: pi's output-guard
  # intermittently crashes with EPIPE when stdout is a pipe (fine to a file),
  # which was the cause of the occasional empty responses.
  OUTFILE="$STATE_DIR/.pi-out.$$"
  cd "$REPO_ROOT" && timeout 150 "$PI" --provider openrouter --model "$MODEL" --thinking high --no-tools -p "$P" > "$OUTFILE" 2>>"$LOGFILE"
  OUT="$(cat "$OUTFILE" 2>/dev/null)"
  rm -f "$OUTFILE"
  # Parse the last RESULT: line (no colour — the LED uses the tariff band).
  line="$(printf '%s\n' "$OUT" | grep -a '^RESULT:' | tail -n1 | sed 's/^RESULT:[[:space:]]*//')"
  line="$(printf '%s' "$line" | sed 's/^["“ ]*//; s/["” ]*$//')"   # strip wrapping quotes/space
  # A legitimate SKIP (news found nothing worth showing) — respect it, no retry.
  if printf '%s' "$line" | grep -qiE '^skip$'; then break; fi
  if [ -n "$line" ]; then
    n="$(TXT="$line" python3 -c 'import os; print(len(os.environ["TXT"]))')"
    [ "$n" -le 64 ] && break   # good line within budget
    extra="Your previous line was $n characters — too long. The whole line must be at most 64 characters. Give a shorter one."
    log "$MODE: retry, prev was $n chars: $line"
  else
    # Empty / unparseable — usually a transient blip; ask again with the format.
    extra="Your previous reply had no parseable answer. Output EXACTLY one line and nothing else: 'RESULT: <text>'."
    log "$MODE: retry, empty/unparseable response"
  fi
done

if [ -z "$line" ]; then
  log "$MODE: no RESULT line parsed; raw: $(printf '%s' "$OUT" | tr '\n' ' ' | tail -c 300)"
  exit 0
fi
if printf '%s' "$line" | grep -qiE '^skip$'; then
  log "news: model declined (SKIP)"
  exit 0
fi

# Char-accurate cap (bash substring counts bytes; the — em-dash is 3 bytes,
# which would clip a character mid-sequence). Server also caps at LED_MAX_CHARS.
line="$(TXT="$line" python3 -c 'import os; print(os.environ["TXT"][:64])')"

# ---- deliver ----------------------------------------------------------------
# No colour sent: the dashboard omits it and the LED shows the message in the
# current tariff-band colour (esp-tou v7+).
payload="$(TXT="$line" TTL="$TTL" python3 -c '
import os, json
print(json.dumps({"title": os.environ["TXT"], "push": False,
                  "ttl": int(os.environ["TTL"])}))')"

if [ "$DRY" = "1" ]; then
  printf 'MODE=%s (colour: band)\n%s\n' "$MODE" "$payload"
  exit 0
fi

[ -f "$REPO_ROOT/.api_keys" ] && source "$REPO_ROOT/.api_keys"
if [ -z "${PUSH_EVENT_TOKEN:-}" ]; then log "$MODE: no PUSH_EVENT_TOKEN"; exit 0; fi

if curl -fsS -m 12 -X POST \
     -H "Content-Type: application/json" \
     -H "X-Push-Token: $PUSH_EVENT_TOKEN" \
     "http://localhost:8000/api/event" -d "$payload" > /dev/null 2>&1; then
  # Record it so future runs don't repeat, and prune the log.
  TXT="$line" MODE="$MODE" NZ="$nzdate" REC="$RECENT" python3 -c '
import os, json, time
row = {"ts": int(time.time()), "date": os.environ["NZ"], "mode": os.environ["MODE"],
       "text": os.environ["TXT"]}
open(os.environ["REC"], "a").write(json.dumps(row) + "\n")
' 2>>"$LOGFILE"
  tail -n 300 "$RECENT" > "$RECENT.tmp" 2>/dev/null && mv "$RECENT.tmp" "$RECENT"
  log "$MODE shown (band): $line"
else
  log "$MODE: POST failed: $line"
fi
