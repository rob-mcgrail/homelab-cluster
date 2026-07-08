# homelab-cluster

Docker Compose stack for a home media server: Jellyfin, Sonarr, Radarr, Prowlarr, qBittorrent, Bazarr, Navidrome, Home Assistant.

## Setup

Follows the [Servarr Docker Guide](https://wiki.servarr.com/docker-guide) path conventions:
- `/data` inside containers is the shared root
- Sonarr/Radarr mount the full `/data` tree (enables hardlinks + atomic moves)
- qBittorrent only sees `/data/torrents`
- Jellyfin only sees `/data/media`

## Storage

Data lives on one or more USB storage drives pooled via mergerfs:
- `/mnt/disk2`, `/mnt/disk3` (3.6 TB each) + `/mnt/disk5` (8 TB) — ext4 USB drives (add more as `/mnt/diskN`)
- `/srv/data` — mergerfs mount pooling them (~15 TB)
- `DATA_ROOT=/srv/data` in `.env` — all containers reference this

Both the disk mounts and mergerfs pool are in `/etc/fstab` with `nofail` so the system boots even if a USB drive isn't plugged in.

(`disk4`, a 2.7 TB Seagate, died of USB-bridge faults and was binned in July 2026 — hence the gap in the numbering.)

The mergerfs create policy is `category.create=epmfs` (existing path, most free space). For a new file/dir, mergerfs picks the branch that already has the parent path *and* has the most free space. This keeps related files together on the same disk so hardlinks (Sonarr/Radarr import `torrents` → `media`) don't cross filesystems and fall back to copies.

For `epmfs` to actually distribute writes, the top-level paths must exist on every disk. Otherwise mergerfs only has one valid branch and everything lands there.

### Adding another drive to the pool

1. Identify: `lsblk` to find the new device (e.g. `/dev/sdb`)
2. Format: `sudo parted /dev/sdb --script mklabel gpt mkpart primary ext4 0% 100% && sudo mkfs.ext4 -L data2 /dev/sdb1`
3. Mount: `sudo mkdir -p /mnt/disk2 && sudo mount /dev/sdb1 /mnt/disk2`
4. Add to fstab: `UUID=... /mnt/disk2 ext4 defaults,nofail 0 2`
5. Update mergerfs fstab line to include the new disk: `/mnt/disk1:/mnt/disk2 /srv/data fuse.mergerfs ...`
6. **Create the core folder structure on the new disk** so `epmfs` can place new content there. Match the layout of the existing disks:
   ```sh
   sudo mkdir -p /mnt/disk2/media/{tv,movies,music,kids/tv,kids/movies} /mnt/disk2/torrents/{movies,music,tv}
   sudo chown -R rob:media /mnt/disk2/media /mnt/disk2/torrents
   sudo chmod -R 775 /mnt/disk2/media /mnt/disk2/torrents
   ```
7. Live-add to the running mergerfs pool without downtime (requires `attr` package: `sudo apt install attr`):
   ```sh
   sudo setfattr -n user.mergerfs.srcmounts -v "+/mnt/disk2" /srv/data/.mergerfs
   ```
   Or, if the stack is down, `sudo umount /srv/data && sudo mount -a`.
8. No container changes needed — mergerfs pools transparently.

### Auditing hardlinks (torrents ↔ media)

Sonarr/Radarr hardlink imports from `/data/torrents` into `/data/media` so the library and seed share one copy on disk. If a hardlink ever fails (e.g. source and destination land on different mergerfs branches when `epmfs` had no shared parent path), the import falls back to a copy — data sits on disk twice.

To audit and automatically relink copies back into hardlinks:

```python
# audit: find media files whose size matches a torrent file but whose inode differs
python3 << 'EOF'
import os
from collections import defaultdict
def walk(root):
    out = []
    for dp, _, fns in os.walk(root):
        for fn in fns:
            try:
                st = os.stat(os.path.join(dp, fn))
                if st.st_size > 50 * 1024 * 1024:
                    out.append((os.path.join(dp, fn), st.st_ino, st.st_size))
            except OSError: pass
    return out
torrents = walk("/srv/data/torrents")
media = walk("/srv/data/media")
tinodes = {f[1] for f in torrents}
tbysize = defaultdict(list)
for p, i, s in torrents: tbysize[s].append((p, i))
copies = []
for p, i, s in media:
    if i in tinodes: continue
    for tp, ti in tbysize.get(s, []):
        if ti != i:
            copies.append((p, tp, s)); break
print(f"copies: {len(copies)}  wasted: {sum(c[2] for c in copies)/1024**3:.1f} GB")
for m, t, s in copies: print(f"  {s/1024**3:5.2f}GB  {m}\n         <- {t}")
EOF
```

To relink a specific batch (replace the `find` path with the torrent folder):

```sh
for mfile in "/srv/data/media/PATH/TO/MEDIA"/*.mkv; do
  fname=$(basename "$mfile")
  tfile=$(find "/srv/data/torrents/TORRENT_FOLDER" -name "$fname" 2>/dev/null | head -1)
  [ -z "$tfile" ] && continue
  [ "$(stat -c %i "$mfile")" = "$(stat -c %i "$tfile")" ] && continue
  rm "$mfile" && ln "$tfile" "$mfile" && echo "relinked: $fname"
done
```

Hardlinks only work within a single branch, so both files must physically live on the same disk under `/mnt/diskN`. With `epmfs` + matching top-level folders on every disk this is the default.

**Gotcha:** copying hardlinked pairs *through* the mergerfs pool (e.g. `rsync -aH` into `/srv/data`) can't recreate the hardlink across branches (`EXDEV`), so it silently writes both halves as full copies — doubling the space. Copy into a single `/mnt/diskN` instead (where `rsync -H` works), then re-link with the audit above. (`~/retired-scripts/relink-hardlinks.sh` automates the sweep if you need it.)

## Key files

- `.env` — all host paths, user/group IDs, timezone. Change `DATA_ROOT` when migrating to a new drive.
- `docker-compose.yml` — service definitions
- `config/` — gitignored, holds per-container config volumes
- `.api_keys` — gitignored, ENV-style file with API keys and URLs for each service. Source this to interact with service APIs (e.g. `source .api_keys && curl -H "X-Api-Key: $SONARR_API_KEY" "$SONARR_URL/api/v3/system/status"`). qBittorrent uses subnet whitelist auth (172.20.0.0/16) so no credentials are needed from the host.

## Ports

| Service      | Port |
|-------------|------|
| Jellyfin    | 8096 |
| Sonarr      | 8989 |
| Radarr      | 7878 |
| Prowlarr    | 9696 |
| qBittorrent | 8080 |
| Bazarr      | 6767 |
| Navidrome   | 4533 |
| Home Assistant | 8123 |
| Pi-hole     | 8090 (web), 53 bound to `${LAN_IP}` |
| tv          | _no host port_ — only via Caddy at `tv.{DOMAIN}` |

## DNS

LAN-only split-horizon setup: a single **wildcard** A record in Cloudflare (gray-cloud, DNS-only) points at the server's LAN IP. Clients on the LAN resolve `*.{DOMAIN}` → LAN IP and connect directly; nothing traverses the public internet. TLS certs are issued via Let's Encrypt DNS-01 challenge (no public reachability required).

If the server's LAN IP changes (e.g. switching from wifi to ethernet), the only update needed is that one Cloudflare wildcard A record — all subdomains follow.

## Pi-hole

Network-wide DNS ad-blocker. Reachable at `https://pihole.{DOMAIN}/admin` (via Caddy) or `http://${LAN_IP}:8090/admin` (direct, fallback).

DNS is bound to `${LAN_IP}:53` only — systemd-resolved stays on loopback (`127.0.0.53`) so host processes still resolve normally. LAN clients point at `${LAN_IP}` via the Orbi's DHCP DNS setting.

Upstream resolvers: `1.1.1.1;1.0.0.1` (Cloudflare). Set via `FTLCONF_dns_upstreams` in the compose file.

Web admin password is in `.api_keys` as `FTLCONF_webserver_api_password` and loaded into the container via `env_file`.

Android-specific notes: each phone's *Private DNS* setting (Settings → Network & Internet) must be **Off** or **Automatic**. Any other value (dns.google, 1dot1dot1dot1.cloudflare-dns.com) bypasses Pi-hole entirely via DoT.

## Home Assistant

Three Reolink floodlight cams (`Front door`, `Deck`, `Shed`) integrated via the Reolink integration. Floodlights auto-on at night when motion + person/vehicle, auto-off after 2 min quiet. Manual `panic_floodlights_and_sirens` script for emergencies (lights + sirens, fired from the dashboard's Floodlights panel).

**Custom HA image** (`./homeassistant-image/Dockerfile`) on top of `ghcr.io/home-assistant/home-assistant:stable` — adds `intel-media-driver` + `LIBVA_DRIVER_NAME=iHD` so HA's bundled ffmpeg can use VAAPI on the Intel iGPU. Container has `/dev/dri:/dev/dri` and `group_add: ["993"]` (host `render` GID).

**HD clip recording** — any person/vehicle detection from any cam fires a single combined automation that calls ALL THREE `shell_command.record_<cam>`s, recording 60s clips on every cam in parallel. (Animal triggers are excluded — too many possum/cat false-positives.) Cross-triggering covers the ~1.5s detect→record latency window during which a fast target can leave one cam's FOV and enter another before its own AI fires. Each shell_command runs `ffmpeg -hwaccel vaapi -c:v h264_vaapi` against go2rtc's RTSP feed and writes a 60s MP4 to `/mnt/disk2/cam-recordings/<cam>/`. The shell_commands are wrapped in `sh -c '... &'` so they return instantly — HA has a hardcoded 60s timeout that would otherwise SIGKILL ffmpeg before it could finalize the MP4 (no `moov` atom = unplayable). Detached, ffmpeg runs to completion under PID 1 reparenting. The automation's `mode: single + delay: 45s` provides one shared event lock — a follow-up trigger from any cam within 45s is dropped because clips are already being captured.

**Presence-aware skip** — `binary_sensor.rob_home` is a template that ORs `device_tracker.kochi == home` (Companion app GPS) with `sensor.kochi_wi_fi_connection == "<home SSID>"` (Companion app WiFi). The clip automations skip daytime detections (07:00–19:00) when home; record always at night, or any time we're away.

See `homeassistant/NOTES.md` for full setup steps, entity IDs, and the Companion app config.

## auth (LAN-bootstrapped cookie gate)

Forward-auth gate for `www.{DOMAIN}` (the dashboard, and eventually anything else exposed via the Cloudflare tunnel). Bun service in `./auth/`, no host ports — reached only on the docker network.

Design: physical LAN presence is the only way to mint a cookie. Once you have it, the cookie is good for `AUTH_COOKIE_LIFETIME_DAYS` (default 21) and travels with you on mobile data, foreign wifi, etc.

**Flow:**
1. Caddy's `www.{DOMAIN}` block has `forward_auth auth:8000 { uri /verify }`.
2. `/verify` checks the `homelab_auth` cookie (HMAC-SHA256 of `<expiry_unix>` keyed by `AUTH_SECRET`, constant-time compared, expiry checked). On 2xx Caddy passes through to dashboard; on 3xx the redirect to `auth.www.{DOMAIN}` is returned to the browser.
3. `auth.www.{DOMAIN}` (also served by Caddy → auth:8000) hits `GET /`, which mints a fresh cookie with `Domain=www.{DOMAIN}; Secure; HttpOnly; SameSite=Lax` and 302s back to `?next=` (validated to our own host) or `https://www.{DOMAIN}/`.
4. `auth.www.{DOMAIN}` is reachable only from the LAN. The existing `*.{DOMAIN}` wildcard A record resolves it to `${LAN_IP}` (a private RFC1918 address) for any resolver — external clients can read the answer but can't route to it. When cloudflared is added later, its ingress rules won't list `auth.www`, so the tunnel can't proxy it either.

Stateless: no DB, no Cloudflare callback. Rotating `AUTH_SECRET` in `.api_keys` invalidates every issued cookie.

No DNS config needed — the existing wildcard does the work.

**Testing the gate (after `docker compose up -d`):**

```sh
# Hit /verify via Caddy from the host — no cookie → 302 to auth.www
source .env && source .api_keys
curl -skI -H "Host: www.${DOMAIN}" https://localhost/    # expect 302, Location auth.www.{DOMAIN}

# Hit auth.www / — should set the cookie and 302 to www
curl -skI -H "Host: auth.www.${DOMAIN}" https://localhost/    # expect 302, Set-Cookie homelab_auth=...

# End-to-end from a LAN browser at https://www.{DOMAIN}:
#   - first visit: 302 → auth.www → 302 back with cookie → dashboard loads
#   - subsequent visits within 21 days: dashboard loads directly
# DevTools should show cookie Domain=www.{DOMAIN}, Expires ~21d out, HttpOnly, Secure
```

## tv

Self-hosted IPTV playlist manager at `tv.{DOMAIN}`. Replaces the previous `tv-five-kappa.vercel.app` setup where the playlist was generated by a Vercel function with no UI.

**What it does:** stores channels in SQLite, renders `/playlist.m3u` from enabled channels (in the order set in the dashboard), and provides a web UI to import upstream M3U feeds, rename / reorder / enable / disable / delete channels, set the EXTVLCOPT user-agent per channel, and open any stream in an in-browser hls.js test player.

**Stack:** Bun + `bun:sqlite`, no external runtime deps. Single `server.ts` plus a static SPA in `tv/public/`. Same shape as the `auth` service.

**Storage:** SQLite at `tv/data/tv.db`, bind-mounted into the container at `/app/data/tv.db`. The file is **committed to the repo** (intentionally not gitignored) — it acts as a soft backup of the channel list, the renames, and the picked user-agents. Reorder + edits write through immediately.

**User-Agent options** (in `USER_AGENTS` at the top of `server.ts`):
| Key       | EXTVLCOPT line written                                                              |
|-----------|-------------------------------------------------------------------------------------|
| `chrome`  | `#EXTVLCOPT:http-user-agent=Mozilla/5.0 … Chrome/126 …` (default for imports)       |
| `appletv` | `#EXTVLCOPT:http-user-agent=otg/1.5.1 (AppleTv Apple TV 4; tvOS16.0; …) libcurl/…`  |
| `blank`   | `#EXTVLCOPT:http-user-agent=` (empty value)                                          |
| `none`    | _no EXTVLCOPT line at all_                                                          |

To add another preset, edit `USER_AGENTS` in `tv/server.ts` — both the API validation and the dropdowns derive from that map.

**Import semantics:** POST `/api/import {url}` (or `{m3u}`) fetches and parses, then inserts new channels by `stream_url`. Re-importing the same feed is a no-op — existing rows are left alone so renames / UA picks / disabled flags survive refreshes. Returns `{parsed, added, skipped}`.

**Reorder:** `position` is a contiguous 1..N sort key. The drag-drop UI POSTs `/api/channels/reorder {order: [id,…]}` which rewrites positions in a single transaction. The rendered M3U emits `tvg-chno` equal to position, so the playlist's channel numbers reflect the UI order.

**Test player:** `GET /play?url=…&name=…` returns an HTML page with hls.js loading the stream. Important caveat: browsers cannot send custom User-Agent headers on media requests, so a stream that's UA-gated upstream (most of the i.mjh.nz / mjh feeds aren't, but some are) may fail in the test player even when VLC / AppleTV can play it fine. The test player is a "is the URL alive and HLS-shaped?" check, not an end-to-end UA validation.

**API quick-ref** (no auth — relies on Caddy LAN-only exposure):

```sh
source .env  # for $DOMAIN
TV_URL="https://tv.${DOMAIN}"

# Render the playlist (what IPTV clients hit)
curl -s "$TV_URL/playlist.m3u" | head

# List all channels (incl. disabled)
curl -s "$TV_URL/api/channels" | python3 -m json.tool | head -40

# Import a remote playlist (merge — new entries only)
curl -s -X POST -H "Content-Type: application/json" "$TV_URL/api/import" \
  -d '{"url": "https://tv-five-kappa.vercel.app/playlist.m3u"}'

# Patch one channel (rename / toggle / set UA)
curl -s -X PATCH -H "Content-Type: application/json" "$TV_URL/api/channels/42" \
  -d '{"display_name": "TVNZ 1 (HD)", "user_agent": "appletv"}'

# Add ONE channel from primitives — Claude Code's "add a channel for me" path.
# `display_name` + `stream_url` are required. Optional: channel_id, tvg_id,
# tvg_logo, group_title, user_agent (default 'chrome'), enabled (default true),
# position (default: append after the current max). Returns 201 + the inserted
# row; 409 + the existing row if stream_url already exists.
curl -s -X POST -H "Content-Type: application/json" "$TV_URL/api/channels" \
  -d '{"display_name": "BBC One HD", "stream_url": "https://example/bbc1.m3u8", "group_title": "Uk", "tvg_logo": "https://example/bbc1.png", "user_agent": "chrome"}'

# Bulk disable
curl -s -X POST -H "Content-Type: application/json" "$TV_URL/api/channels/bulk" \
  -d '{"ids": [1,2,3], "action": "disable"}'
```

## jellyfin-proxy

Openresty sidecar that rewrites `PlaybackInfo` on the `jellyfin-force-transcode.{DOMAIN}` subdomain to force HEVC transcoding for clients whose decoders stutter on real HEVC (Android TV). See `openresty/README.md` for the why, architecture, and gotchas.

## LED display

A LAN device with custom firmware that shows a short message on a small LCD:
`GET http://<ip>/show?text=<brief>&ttl=<seconds>&colour=<RRGGBB>`. Its address
is `LED_URL` in `.env` (`http://192.168.1.47`), passed to the dashboard container.

**Single egress point.** *Only* the dashboard ever talks to the device — via
`showOnLed()` in `dashboard/server.ts`. Every other source (HA, Radarr/Sonarr,
the recs cron) POSTs to the dashboard's internal API, which relays server-side.
This is what lets the LED work when the dashboard is opened remotely over the CF
tunnel: the browser never needs LAN reachability to `192.168.x`. Docker-bridge
NAT already lets the dashboard reach the LAN device — no extra container/network
config. If `LED_URL` is unset, every LED path no-ops.

**Semantic-but-creative palette** (RRGGBB, defined once as `LED` in `server.ts`,
mirrored in the panel swatches):

| Event                     | Colour       | Hex      |
|---------------------------|--------------|----------|
| Download imported (arr)   | green        | `00e676` |
| Recommendations ready     | aquamarine   | `40e0d0` |
| Request incoming to bot   | amber        | `ff9e00` |
| System health alert       | red          | `ff2d55` |
| Push test                 | cyan         | `00e5ff` |

**No colour → band colour:** when a caller sends **no** `colour`, `showOnLed`
omits it and the device (esp-tou **v7+**) renders the message in the **current
tariff-band colour** (green/amber/red). That's the default for generic push
mirrors and the news/quotes curator. The explicit colours above still override.

**Endpoints (`server.ts`):**
- `POST /api/led {text, colour?, ttl?}` — the dashboard's **LED panel**
  (`public/panels/led.js`). No token; behind Caddy's LAN-only auth like every
  browser endpoint. `ttl` defaults to 10s; text hard-capped to `LED_MAX_CHARS`
  (40) and collapsed to one line.
- `POST /api/event` — extended: **every push also mirrors to the LED** unless the
  caller passes `led:false` (HA's camera alert does — floodlights already fire,
  so the LCD echo adds nothing). `push:false` makes an event LED-only. Optional
  `colour` (RRGGBB) / `ttl` / `ledText` (override the longer push title). Omit
  `colour` and the LED shows the message in its current tariff-band colour.
- `POST /api/arr-webhook?token=$PUSH_EVENT_TOKEN` — Radarr/Sonarr "On Import"
  Webhook connection (created via their `/api/v3/notification`, name "LED
  display"). Parses their native movie/series payload → green title. LED-only.

The **amber "request incoming"** LED fires from *both* ways a request enters the
bot queue: the manual prompt box (`/api/prompt`) and the recs panel's "send to
movie bot" button (`/api/recs/:id/send-to-moviebot`) — the latter is the common
path. Both are LED-only (no phone push).

**Server-side health monitor:** a 60s tick in `server.ts` fires a red alert when
disk ≥90%, 1-min load ≥3×cores, or a container is crash-looping — each with a
30-min re-alert cooldown, cleared when the condition resolves.

## LED news & quotes (ambient curator)

`news-led/run-news-led.sh` — a host cron job (`*/5 * * * *`) that regularly
surfaces one genuinely-interesting item on the LCD: either a **news** headline or
a **quote/aphorism**. It's LED-only (`push:false`) — ambient, never a phone buzz.
Like the other bots it POSTs to the dashboard's `/api/event` (the single LED
egress); no `server.ts` changes.

Each 5-min tick:
1. **Waking-hours gate** — proceeds only 07:00–23:00 **NZ local**, read via
   `TZ="Pacific/Auckland"` so it self-corrects for NZDT/NZST (the host is UTC).
2. **Rate gate** — fires ~2/3 of ticks (`TARGET_SHOWS_PER_HOUR`/`ATTEMPTS_PER_HOUR`
   = 8/12) so it averages **~8/hour**.
3. **Mode** — ~50/50 news vs quote (`QUOTE_PCT`). News may return **SKIP** only if
   nothing is of any interest (rare now); quotes never skip.
4. **Curation** — a `pi` call (`deepseek-v4-flash`, `--thinking high`, `--no-tools`):
   - *news*: fetches RSS (`fetch-headlines.py`: BBC World/Business, Guardian
     World, RNZ, Ars Technica, HN) and picks ONE crisp ≤64-char line for the
     persona — mid-40s Whanganui web dev, into global affairs + philosophy.
   - *quote*: one **deep cut** — an obscure-but-genuine line from the great
     aphorists (Nietzsche, Leibniz, Pascal, …) **plus Mao & Lenin**, with the
     famous greatest-hits explicitly banned. **No attribution shown** (Rob guesses).
   - **No colour is sent** — the payload omits it, so the LED shows each line in
     the **current tariff-band colour** (green/amber/red) via esp-tou v7+.
   - Overruns 64 chars, or an empty/unparseable reply → **one retry**; char-accurate
     cap as last resort.
5. **Recycling allowed** — recent lines are logged to `news-led/state/recent.jsonl`
   (gitignored, last 300) and fed back to bias toward variety, but at this cadence
   repeats are fine — a huge story re-showing beats going quiet.

Prompts live in `news-led/news-prompt.txt` / `quotes-prompt.txt` (tune the bar,
roster, or persona there). Config knobs (waking window, rate, quote %, colours,
model, feeds) are at the top of the script. Manual test flags: `--now` (skip
gates), `--dry` (print, don't post), `--news` / `--quote` (force mode). Runtime
log: `news-led/state/run.log`.

## Jellyfin libraries

| Library     | Type    | Path                   |
|-------------|---------|------------------------|
| Shows       | tvshows | `/data/media/tv`       |
| Movies      | movies  | `/data/media/movies`   |
| Kids TV     | tvshows | `/data/media/kids/tv`  |
| Kids Movies | movies  | `/data/media/kids/movies` |

## Quality profiles

| Profile      | Use for                         | Max (2hr movie) | Notes                        |
|--------------|---------------------------------|-----------------|------------------------------|
| Rob1080      | TV, kids content, default       | ~18 GB          | Radarr: 1080p only. Sonarr: 720p + 1080p (some shows just aren't available in 1080p). HEVC preferred (+10 score) |
| Rob4K        | Movies (when disk space allows) | ~34 GB          | 1080p Bluray + 4K WEB/Bluray, no remuxes  |
| RobDifficult | Auto-applied to stuck movies    | ~35 GB (Remux)  | Adds 720p tiers (≥3 GB only) and Remux-1080p / Remux-2160p on top of Rob4K. The triage bot escalates to this profile when a movie has been monitored+missing for 14+ days. |

All three profiles block YTS/YIFY via a `-10000` custom format score and prefer HEVC (+10).

When adding new content: use **Rob1080** for all TV shows (Sonarr) and any kids content. Use **Rob4K** for recent releases, highly cinematic films (Scorsese, Kubrick, PTA, etc.), and anything where the visual quality is worth it. When in doubt for movies, prefer Rob1080. **Don't manually assign RobDifficult** — let the triage bot escalate to it after the strict profiles have failed for two weeks. Cutoff is Bluray-2160p so any later high-quality release still triggers an upgrade.

### Size limits (MB/min, per quality definition)

Radarr and Sonarr each have their own set of quality definitions. Values below are **Radarr's**:

| Quality        | Min | Preferred | Max |
|----------------|----:|----------:|----:|
| HDTV-720p      |  25 |        95 | 100 |
| WEBDL-720p     |  25 |        95 | 100 |
| WEBRip-720p    |  25 |        95 | 100 |
| Bluray-720p    |  25 |        95 | 100 |
| HDTV-1080p     |  20 |        50 |  55 |
| WEBDL-1080p    |  20 |        50 |  65 |
| WEBRip-1080p   |  20 |        50 |  90 |
| Bluray-1080p   |  20 |        60 | 150 |
| Remux-1080p    |  20 |        60 | 290 |
| HDTV-2160p     |   0 |       160 | 200 |
| WEBDL-2160p    |   0 |       160 | 200 |
| WEBRip-2160p   |   0 |       160 | 250 |
| Bluray-2160p   |   0 |       160 | 280 |

Trade-off notes:
- **Bluray-1080p max=150** is intentionally permissive so OFT/SPARKS-style x264 catalog releases for obscure films still qualify where no x265 alternative exists. Tightening to ~90-100 would bias harder toward x265 (SARTRE, r00t, BONE, SM737) but would miss some OFT-only titles.
- **min=20** on 1080p tiers auto-rejects YIFY-sized releases (~8-16 MB/min) even before the custom-format penalty hits.
- **720p min=25** (~3 GB at 120 min) means RobDifficult only accepts solid 720p rips, not micro-encodes. Rob1080/Rob4K don't allow 720p at all so this only affects RobDifficult.
- **Remux-1080p max=290** caps a 2 hr Remux at ~35 GB. Only RobDifficult accepts Remux-1080p.

### Release group notes

- **OFT** — "catalog completer" group. x264 1080p BluRay rips, often the only 1080p option for obscure arthouse/cult/older titles. Quality fine, aspect ratios preserved, single audio track typical. Expected and welcome in this library.
- **SARTRE, r00t, BONE, SM737, HazMatt, DarkAngie (Tigole-family), TheUpscaler** — x265 HEVC encoders, preferred when available (Rob1080's +10 HEVC score nudges toward these).
- **YTS/YIFY** — blocked. Bitrates too low, transcoding tends to look bad.

## Sonarr root folders

- `/data/media/tv` — main TV
- `/data/media/kids/tv` — kids TV (e.g. My Little Pony)

Ensure `seasonFolder: true` is set on series so episodes sort into `Season N/` subdirectories.

## API cheat sheet

All examples assume `source .api_keys` has been run first.

### Sonarr

```sh
# List all series
curl -s -H "X-Api-Key: $SONARR_API_KEY" "$SONARR_URL/api/v3/series" | python3 -c "import sys,json; [print(f'{s[\"id\"]}: {s[\"title\"]}') for s in json.load(sys.stdin)]"

# Search for missing episodes for a series (by series ID)
curl -s -X POST -H "X-Api-Key: $SONARR_API_KEY" -H "Content-Type: application/json" "$SONARR_URL/api/v3/command" -d '{"name": "SeriesSearch", "seriesId": ID}'

# Rename/move files into season folders (by series ID)
FILEIDS=$(curl -s -H "X-Api-Key: $SONARR_API_KEY" "$SONARR_URL/api/v3/rename?seriesId=ID" | python3 -c "import sys,json; print(json.dumps([e['episodeFileId'] for e in json.load(sys.stdin)]))")
curl -s -X POST -H "X-Api-Key: $SONARR_API_KEY" -H "Content-Type: application/json" "$SONARR_URL/api/v3/command" -d "{\"name\": \"RenameFiles\", \"seriesId\": ID, \"files\": $FILEIDS}"

# Scan a download folder for import
curl -s -X POST -H "X-Api-Key: $SONARR_API_KEY" -H "Content-Type: application/json" "$SONARR_URL/api/v3/command" -d '{"name": "DownloadedEpisodesScan", "path": "/data/torrents/FOLDER"}'

# Check command status
curl -s -H "X-Api-Key: $SONARR_API_KEY" "$SONARR_URL/api/v3/command/COMMAND_ID" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['status'])"
```

### Radarr

```sh
# List all movies
curl -s -H "X-Api-Key: $RADARR_API_KEY" "$RADARR_URL/api/v3/movie" | python3 -c "import sys,json; [print(f'{m[\"id\"]}: {m[\"title\"]}') for m in json.load(sys.stdin)]"

# List quality profiles (get profile IDs: Rob1080=7, Rob4K=8)
curl -s -H "X-Api-Key: $RADARR_API_KEY" "$RADARR_URL/api/v3/qualityprofile" | python3 -c "import sys,json; [print(f'{p[\"id\"]}: {p[\"name\"]}') for p in json.load(sys.stdin)]"

# Search for a movie (by movie ID)
curl -s -X POST -H "X-Api-Key: $RADARR_API_KEY" -H "Content-Type: application/json" "$RADARR_URL/api/v3/command" -d '{"name": "MoviesSearch", "movieIds": [ID]}'

# Bulk change quality profile on multiple movies then trigger upgrade search.
# NB: this shell is zsh — `for id in $VAR` does NOT word-split, so use an array with "${ARR[@]}".
# NB: PUT requires the full movie body, not a partial — so GET, mutate, PUT.
IDS=(49 51 52)   # movie IDs
PROFILE=8        # Rob4K
for id in "${IDS[@]}"; do
  curl -s -H "X-Api-Key: $RADARR_API_KEY" "$RADARR_URL/api/v3/movie/$id" \
    | python3 -c "import sys,json; m=json.load(sys.stdin); m['qualityProfileId']=$PROFILE; print(json.dumps(m))" \
    | curl -s -X PUT -H "X-Api-Key: $RADARR_API_KEY" -H "Content-Type: application/json" "$RADARR_URL/api/v3/movie/$id" -d @- \
    | python3 -c "import sys,json; m=json.load(sys.stdin); print(f'{m[\"id\"]}\tprofile={m[\"qualityProfileId\"]}\t{m[\"title\"]}')"
done
# Then one batched search for all:
IDS_JSON=$(python3 -c "import sys; print('['+','.join(sys.argv[1:])+']')" "${IDS[@]}")
curl -s -X POST -H "X-Api-Key: $RADARR_API_KEY" -H "Content-Type: application/json" "$RADARR_URL/api/v3/command" -d "{\"name\": \"MoviesSearch\", \"movieIds\": $IDS_JSON}"
```

### Bazarr

```sh
# Check provider status
curl -s -H "X-API-KEY: $BAZARR_API_KEY" "$BAZARR_URL/api/providers" | python3 -m json.tool

# List movies and subtitle status
curl -s -H "X-API-KEY: $BAZARR_API_KEY" "$BAZARR_URL/api/movies?start=0&length=100" | python3 -c "
import sys,json
for m in json.load(sys.stdin).get('data', []):
    subs = [s.get('code2','?') for s in m.get('subtitles', []) if s.get('path')]
    miss = [s.get('code2','?') for s in m.get('missing_subtitles', [])]
    print(f'{m[\"title\"]:30s}  has: {subs}  missing: {miss}')
"

# Trigger subtitle search for a movie (by radarrId)
curl -s -X PATCH -H "X-API-KEY: $BAZARR_API_KEY" -H "Content-Type: application/json" "$BAZARR_URL/api/movies/subtitles?radarrid=ID" -d '{"language": "en", "forced": "False", "hi": "False"}'

# Clear provider throttle (when providers get stuck in backoff)
docker exec bazarr sh -c '> /config/config/throttled_providers.dat'
docker restart bazarr
```

### Jellyfin

```sh
# List libraries
curl -s -H "X-MediaBrowser-Token: $JELLYFIN_API_KEY" "http://localhost:8096/Library/VirtualFolders" | python3 -c "
import sys,json
for lib in json.load(sys.stdin):
    print(f'{lib[\"Name\"]}  ({lib.get(\"CollectionType\",\"mixed\")})  {lib.get(\"Locations\",[])}')
"

# Trigger full library scan
curl -s -X POST -H "X-MediaBrowser-Token: $JELLYFIN_API_KEY" "http://localhost:8096/Library/Refresh"

# Force metadata refresh for an item (by item ID)
curl -s -X POST -H "X-MediaBrowser-Token: $JELLYFIN_API_KEY" "http://localhost:8096/Items/ITEM_ID/Refresh?replaceAllMetadata=true&replaceAllImages=true"

# Search for an item
curl -s -H "X-MediaBrowser-Token: $JELLYFIN_API_KEY" "http://localhost:8096/Items?searchTerm=QUERY&Recursive=true&fields=Path&limit=10"
```
