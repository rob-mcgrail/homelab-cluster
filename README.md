# homelab-cluster

Docker Compose stack for a home media server with a mobile-first dashboard and an AI-powered movie bot.

**Services:** Jellyfin, Sonarr, Radarr, Prowlarr, qBittorrent, Bazarr, Navidrome (music streaming), Home Assistant (Reolink cameras + floodlight automation), Pi-hole (network-wide DNS + ad-blocking + optional DHCP), Caddy (reverse proxy), jellyfin-proxy (HEVC force-transcode shim), Dashboard (Movie Bot + ad-hoc YouTube grab panel), tv (IPTV playlist manager)

## What it does

- **Movie Bot** — a web dashboard where you type a request ("get me the Scorsese filmography") and a cron job picks it up and runs Claude Code to add content via the arr stack APIs
- **HTTPS everywhere** — Caddy gets real Let's Encrypt certs via Cloudflare DNS-01 challenge, no ports exposed to the internet
- **Mobile app** — swipeable panels with pull-to-refresh: prompt input, response history, torrent status, server stats, service links
- **Desktop grid** — all panels visible at once with auto-polling

## Prerequisites

- Ubuntu/Debian server
- A domain on Cloudflare (DNS only, not proxied)
- A Cloudflare API token with Zone:DNS:Edit permission
- A USB drive or disk mounted for media storage

## Setup

### 1. Install dependencies

```sh
# Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER

# jq (used by backup/restore scripts)
sudo apt install -y jq

# Claude Code (for Movie Bot)
curl -fsSL https://claude.ai/install.sh | sh

# mergerfs (for drive pooling)
sudo apt install -y mergerfs
```

Log out and back in after adding yourself to the docker group.

### 2. Mount your storage

```sh
# Format and mount your drive (adjust device as needed)
sudo mkdir -p /mnt/disk1 /srv/data
sudo mount /dev/sda1 /mnt/disk1

# Set up mergerfs pool (add to /etc/fstab for persistence)
sudo mergerfs -o defaults,allow_other,use_ino,cache.files=partial,dropcacheonclose=true,category.create=epmfs /mnt/disk1 /srv/data
```

See `CLAUDE.md` for fstab entries and adding more drives.

### 3. Clone and configure

```sh
git clone <repo-url> && cd homelab-cluster
```

Create system users and group for the containers:

```sh
sudo ./setup.sh
```

Edit `.env` to set your domain and check paths/UIDs match your system.

### 4. API keys

```sh
cp .api_keys.example .api_keys
```

Fill in API keys from each service's web UI (Settings > General > API Key) and your Cloudflare API token.

### 5. DNS

Add a wildcard A record on Cloudflare pointing to your server's LAN IP:

| Type | Name | Content | Proxy |
|------|------|---------|-------|
| A | `*` | `192.168.1.x` | DNS only |

Or add individual A records for: `jellyfin`, `sonarr`, `radarr`, `prowlarr`, `qbittorrent`, `bazarr`, `www`

### 6. Start everything

```sh
docker compose up -d
```

Caddy will automatically obtain HTTPS certificates via DNS-01 challenge on first boot.

> **Note:** The Jellyfin service is configured for Intel QuickSync (QSV) hardware transcoding via `/dev/dri` and the `jellyfin-opencl-intel` Docker mod. If you don't have an Intel iGPU, remove the `devices`, `group_add`, and `DOCKER_MODS` lines from the Jellyfin service in `docker-compose.yml`.

### 7. Restore service settings

The repo includes exported settings for all services (quality profiles, naming conventions, download clients, etc.). Once the containers are running and `.api_keys` is populated:

```sh
./scripts/restore-settings.sh
```

This restores:
- **Radarr/Sonarr** — custom formats, quality profiles, quality definitions, root folders, naming
- **qBittorrent** — preferences, categories
- **Pi-hole** — adlists, static DHCP leases, DNS upstreams (requires `PIHOLE_URL` and `FTLCONF_webserver_api_password` in `.api_keys`)

After restoring, you'll need to manually:
- Re-enter download client passwords in Sonarr/Radarr
- Re-enter subtitle provider credentials in Bazarr
- Re-add Prowlarr app connections (API keys change on reinstall)

To back up settings after making changes:

```sh
./scripts/backup-settings.sh
```

This exports current settings to `settings/` (secrets are stripped).

### 8. Movie Bot cron

Add to your crontab (`crontab -e`):

```
* * * * * /path/to/homelab-cluster/movie-bot-requests/run-prompt.sh
0 */4 * * * /path/to/homelab-cluster/movie-bot-download-triage/run-triage.sh
0 6 * * 0 /path/to/homelab-cluster/movie-bot-recommendations/run-recs.sh
0 3 * * * /path/to/homelab-cluster/movie-bot-double-features/run-double-features.sh
0 4 * * * /path/to/homelab-cluster/scripts/missing-sweep.sh
0 5 * * 1 /path/to/homelab-cluster/scripts/cutoff-sweep.sh
```

- **`run-prompt.sh`** — every minute, picks up new user prompts from the dashboard queue and runs Claude Code to process them.
- **`run-triage.sh`** — every 4 hours, judgment-driven review of (a) the qBittorrent queue and (b) Radarr's monitored-but-missing list. On the torrent side: pauses + re-searches stalled torrents, removes + blocklists dead releases, cleans up orphaned `missingFiles` (with a safety cap), and priority-boosts fresh small-batch requests. On the Radarr side: triggers per-movie fresh searches on stuck-missing titles and escalates the quality profile to **RobDifficult** when a movie has been monitored+missing for 14+ days under a stricter profile. See `movie-bot-download-triage/triage-prompt.txt` for the full decision framework.
- **`run-recs.sh`** — every Sunday at 06:00 UTC, generates fresh film recommendations based on the user's watch history, saved thoughts, and prior rec ratings (seen-good / seen-bad). Appends recs to `movie-bot-data/recommendations.jsonl` for the dashboard Recs Bot panel to display. See `movie-bot-recommendations/recs-prompt.txt` for the decision framework.
- **`run-double-features.sh`** — every night at 03:00 UTC, proposes thematic double-feature pairings drawn from the Jellyfin "Films" library (excluding already-watched and already-paired titles). No-ops if the panel already holds 6+ non-dismissed suggestions, and adds at most 2 per run. Suggestions live as one markdown file per pairing in `movie-bot-data/double-features/`; dismissing one moves the file to `movie-bot-data/dismissed-double-features/` so the bot won't repeat it. See `movie-bot-double-features/double-features-prompt.txt` for the decision framework.
- **`missing-sweep.sh`** — every day at 04:00 UTC, triggers `MissingEpisodeSearch` (Sonarr) and `MissingMoviesSearch` (Radarr). Fills gaps where a monitored item has no file yet. Daily because new releases appear regularly and recently-monitored series often have many missing episodes.
- **`cutoff-sweep.sh`** — every Monday at 05:00 UTC, triggers `CutoffUnmetEpisodeSearch` (Sonarr) and `CutoffUnmetMoviesSearch` (Radarr). Pulls upgrades for items below the quality profile's cutoff. Weekly because backlog upgrades materialise slowly — better releases of old catalog content are rare — so daily would be load for near-zero signal. Both sweeps log to `movie-bot-data/sweep-logs/`.

### 9. Pi-hole (optional but recommended)

Pi-hole comes up with the rest of the stack and **already blocks ads across any client pointed at it for DNS**. The steps below are to actually route your LAN through it.

**Default topology:** router does DHCP, Pi-hole does DNS. The server itself is on a static IP via netplan so it doesn't depend on DHCP at all — see `docs/orbi-dhcp-mysteries.md` for the rationale.

**Networking model:**

- Runs in `network_mode: host` so DHCP broadcasts (UDP 67) can reach it — bridge mode silently breaks for DHCP. (Only relevant if you move DHCP to Pi-hole; see below.)
- Binds DNS (`:53`) only to specific interface IPs (`${LAN_IP}`, loopback, link-local v6), not `0.0.0.0` — this avoids conflict with Ubuntu's systemd-resolved on `127.0.0.53:53`. Host processes keep using resolved; LAN clients hit Pi-hole.
- Web UI runs on `:7001` (changed from default `:80` to keep out of Caddy's way); Caddy reverse-proxies to it at `https://pihole.{DOMAIN}/admin/`.

**Route your LAN through Pi-hole for DNS:**

In your router's admin UI, set the DHCP-pushed DNS to `${LAN_IP}` (the IP of this box). If your router insists on two DNS entries, **duplicate** the same IP — don't add `1.1.1.1` as secondary, or clients will silently leak past Pi-hole on timeouts.

Devices pick up the new DNS on their next DHCP renewal. Toggle Wi-Fi on a client to force it immediately.

**Android gotcha:** each phone's *Settings → Network & Internet → Private DNS* must be **Off** or **Automatic**. Any other value (dns.google, 1dot1dot1dot1.cloudflare-dns.com) tunnels DNS over TLS past Pi-hole.

**Recovery if Pi-hole dies** and DNS goes out for the whole LAN: set your router's DHCP-pushed DNS back to a public resolver (`1.1.1.1`). Takes ~30 seconds, buys time to debug.

#### Optional: move DHCP to Pi-hole

Pi-hole can also serve DHCP. The reason to consider it: Pi-hole can only attribute DNS queries to *hostnames* (rather than just IPs) if it's also issuing the leases. Moving DHCP to Pi-hole gives you per-client labels in the query log and the dashboard's Clients panel.

Trade-offs worth knowing before you switch (detail in `docs/orbi-dhcp-mysteries.md`):

1. **Turn off router DHCP first.** Two DHCP servers on one L2 is a race.
2. **The server becomes both DHCP server and DHCP client.** If it loses its lease and can't renew (it's asking itself for one), it gets stuck in a chicken-and-egg. The fix is a static IP on `eno1` via netplan — already done in this setup.
3. **Some devices (e.g. Orbi mesh satellites) reject DHCPACKs whose `server-identifier` isn't the router's IP.** Symptom: device won't come online. Mitigation: force the server-id via `dhcp-option-force=option:server-identifier,<router-ip>` and reserve that device's MAC.

To enable:

1. In Pi-hole admin (`https://pihole.{DOMAIN}/admin/settings/dhcp`), enable DHCP with the same range your router was using (typically `192.168.1.2`–`192.168.1.254`, router/gateway `192.168.1.1`, netmask `255.255.255.0`, lease `24h`).
2. Recreate any static leases in *Static DHCP leases*. Via CLI:
   ```sh
   docker exec pihole pihole-FTL --config dhcp.hosts '["AA:BB:CC:DD:EE:FF,192.168.1.33,SERVER"]'
   ```
3. In the router: disable its DHCP server.
4. Toggle Wi-Fi on one device to verify it gets a lease from Pi-hole. If something breaks: re-enable router DHCP and disable Pi-hole DHCP — you're back where you started in under 30 seconds.

## Accessing services

All services are available via HTTPS at `<service>.yourdomain.org`:

| Service | URL |
|---------|-----|
| Dashboard | `https://www.yourdomain.org` |
| Jellyfin | `https://jellyfin.yourdomain.org` |
| Jellyfin (force HEVC transcode) | `https://jellyfin-force-transcode.yourdomain.org` |
| Sonarr | `https://sonarr.yourdomain.org` |
| Radarr | `https://radarr.yourdomain.org` |
| Prowlarr | `https://prowlarr.yourdomain.org` |
| qBittorrent | `https://qbittorrent.yourdomain.org` |
| Bazarr | `https://bazarr.yourdomain.org` |
| Navidrome | `https://navidrome.yourdomain.org` |
| Home Assistant | `https://ha.yourdomain.org` |
| Pi-hole | `https://pihole.yourdomain.org/admin` |
| tv (IPTV playlist manager) | `https://tv.yourdomain.org` (UI), `https://tv.yourdomain.org/playlist.m3u` (IPTV endpoint) |

Services are also available on their original ports via IP for direct access.

## Dashboard

The dashboard is a mobile-first web app at `https://www.yourdomain.org` with 9 swipeable panels (left → right):

1. **Double Features** (emerald green, otter) — thematic double-feature pairings from the Jellyfin "Films" library generated by `run-double-features.sh`. Dismissing a suggestion moves it to a dismissed folder so the bot won't re-propose it.
2. **Recs** (teal, birds) — weekly AI film recommendations from `run-recs.sh` with thumbs up/down feedback that feeds future rec generations
3. **History** (green, fish) — recent Movie Bot prompts and responses
4. **Movie Bot** (orange, crab) — submit requests to the AI
5. **Downloads** (blue, octopus) — active torrents. Filters: **Downloading** (qBit-active — including stalled), **Seeding** (done / queued-UP), **Triaged** (anything with a `triage-*` tag, plus freshly-queued downloads that haven't become active yet). Triaged items show a sub-badge with the specific state (`paused`, `resumed`, `queued`, `stopped`, `error`, `missing`, `unknown`) and how long they've been in it.
6. **Server** (purple, bugs) — CPU load, memory, swap, disk usage, plus active Jellyfin streams with transcoding / source-vs-output detail
7. **Floodlights** (coral, fox) — Reolink floodlight cam controls via Home Assistant: per-cam + "All" toggles, live MJPEG previews of each cam (tap for fullscreen HD), recent motion-triggered HD clips (paired by event, side-by-side playback), a two-tap **PANIC** button (lights + sirens), and a single-tap **SILENCE SIRENS** button to undo the siren part. See `homeassistant/NOTES.md` for the recording pipeline + presence-aware skip logic.
8. **YouTube** (lavender, clouds) — paste a YouTube URL, watch it land in the Kids TV library. Posts to `/api/youtube-grab`, which fire-and-forget spawns `scripts/youtube-grab.sh` (yt-dlp inside the dashboard container; serialized via `flock` so concurrent submissions queue up rather than racing). Output lands at `/data/media/kids/youtube/<Channel>/<Title> [<id>].{mp4,nfo,info.json}` plus `<...>-thumb.jpg`; per-channel `tvshow.nfo` + `poster.jpg` + `fanart.jpg` are written on first video. NFOs use the `<episodedetails>` / `<tvshow>` schema so each channel surfaces as a Jellyfin TV show with its YouTube videos as episodes. The script is also runnable from the host CLI for one-off use.
9. **Services** (yellow, bees) — quick links to all service dashboards

#### Optional: Pi-hole panel

A red-themed Pi-hole panel (skulls + bats) can be appended to the swipeable list via the `PIHOLE_PANEL` env var on the dashboard service. Values:

- `off` (default) — panel hidden.
- `blocks` — top 20 blocked domains in the last 24h. Works with any DHCP topology.
- `clients` — per-client allowed/blocked counts. Only useful when Pi-hole itself is the DHCP server and can see individual client IPs; under the default topology (router does DHCP, DNS is proxied through a single IP) all queries look like they come from the router, so this view is empty.

Change the value in `docker-compose.yml` and `docker compose up -d dashboard` to apply.

## Storage

Data lives on a drive pool via mergerfs. See `CLAUDE.md` for details on the storage setup and how to add drives.

## External access (optional)

By default the entire stack is LAN-only — every subdomain resolves to your server's private IP via the wildcard A record, and there are no inbound ports open at the router. The setup below adds external access to a single hostname (the dashboard) via a Cloudflare Tunnel, gated by a stateless cookie that can only be **minted from the LAN**. Once minted, the cookie is good for 21 days (configurable) and works wherever you are — mobile data, foreign wifi, on a plane, etc.

The pattern: physical LAN presence is the only credential that issues a long-lived, offline-usable cookie. Anyone who's been on the LAN gets in; anyone who hasn't can't — even with full knowledge of your domain.

### How it works

External request flow:

1. Browser → Cloudflare edge → persistent QUIC tunnel → `cloudflared` (host systemd service) → Caddy on `127.0.0.1:443` → Caddy's `www.{DOMAIN}` block.
2. Caddy `forward_auth` calls `auth:8000/verify`. The auth container is a ~50-line Bun service that checks the `homelab_auth` cookie (HMAC-SHA256 of an expiry timestamp, keyed by `AUTH_SECRET`, constant-time compared).
3. If the cookie verifies: 2xx, dashboard renders. If not: auth returns a 302 to `https://auth.www.{DOMAIN}/?next=<original URL>`, Caddy passes the redirect through.
4. `auth.www.{DOMAIN}` resolves only via the existing wildcard → `${LAN_IP}` (a private IP, unreachable externally) and isn't listed in cloudflared's ingress rules. So the cookie can only be minted from inside the LAN.
5. Cookie is stateless — no DB, no callback to Cloudflare — so it works on devices that are offline, on a flaky connection, or behind weird captive portals.

### Setup

#### 1. Generate an auth secret

```sh
echo "AUTH_SECRET=$(openssl rand -hex 32)" >> .api_keys
echo "AUTH_COOKIE_LIFETIME_DAYS=21" >> .api_keys
```

Rotating `AUTH_SECRET` later invalidates every previously-issued cookie.

#### 2. Bring up the auth container

The `auth` compose service, Caddy's `forward_auth` directive on `www.{DOMAIN}`, and the `auth.www.{DOMAIN}` site block are already in the repo. Apply:

```sh
docker compose up -d --build auth
docker compose restart caddy
```

Verify from a LAN browser by opening `https://www.{DOMAIN}` in a private window — you should bounce to `auth.www.{DOMAIN}`, get a cookie, and land on the dashboard. DevTools should show the cookie with `Domain=www.{DOMAIN}`, `Expires` ~21 days out, `HttpOnly`, `Secure`.

Once it works, you can mint a fresh cookie any time by tapping the **Auth** link in the dashboard's Services panel — useful right before a trip.

#### 3. Install cloudflared on the host

cloudflared runs as a systemd service on the host, not in docker — there's no reason to add docker-networking complexity for a process that just dials outbound.

```sh
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install -y cloudflared
```

#### 4. Create the tunnel

```sh
cloudflared tunnel login                          # interactive; opens a browser to authorize the zone
cloudflared tunnel create homelab                 # prints the tunnel UUID
source .env
cloudflared tunnel route dns homelab "www.${DOMAIN}"
```

The third command creates a CNAME `www.{DOMAIN} → <uuid>.cfargotunnel.com` at Cloudflare. It's more specific than the wildcard A record, so it overrides the wildcard for `www` only — all your other subdomains keep resolving to your LAN IP.

#### 5. Move credentials + write the tunnel config

```sh
UUID=$(cloudflared tunnel list | awk '/homelab/{print $1; exit}')
sudo mkdir -p /etc/cloudflared
sudo mv ~/.cloudflared/${UUID}.json /etc/cloudflared/
sudo chown root:root /etc/cloudflared/${UUID}.json
sudo chmod 600 /etc/cloudflared/${UUID}.json

source .env
sudo tee /etc/cloudflared/config.yml >/dev/null <<EOF
tunnel: ${UUID}
credentials-file: /etc/cloudflared/${UUID}.json

# www is the only hostname routed through the tunnel. Anything else
# falls through to a 404 even if its name happened to resolve to
# cfargotunnel.com. originServerName makes cloudflared send SNI matching
# the LE cert Caddy serves, so Caddy picks the right site block and TLS
# validates cleanly against 127.0.0.1:443.
ingress:
  - hostname: www.${DOMAIN}
    service: https://localhost:443
    originRequest:
      originServerName: www.${DOMAIN}
  - service: http_status:404

no-autoupdate: true
EOF
```

#### 6. Install + start the systemd service

```sh
sudo cloudflared service install
sudo systemctl status cloudflared --no-pager
```

`cloudflared service install` creates `/etc/systemd/system/cloudflared.service` pointing at `/etc/cloudflared/config.yml`, enables it, and starts it. Look for `active (running)` and "Registered tunnel connection" lines in `journalctl -u cloudflared -n 30 --no-pager` (usually 4 lines, one per Cloudflare edge POP).

#### 7. Smoke test from outside the LAN

From a phone on mobile data (or a hotspot off your home wifi):

```
https://www.{DOMAIN}
```

- **Without a cookie:** browser bounces to `auth.www.{DOMAIN}` which doesn't resolve to anything routable from outside — you get a connection error. That's the gate working as intended.
- **With a cookie** (mint one first by visiting `auth.www.{DOMAIN}` from the LAN): dashboard loads normally over the tunnel.

#### 8. (Recommended) Keep LAN dashboard traffic local

After step 4, every DNS resolver — including Pi-hole's upstream — sends `www.{DOMAIN}` to the tunnel. LAN browsers still reach the dashboard, but their traffic round-trips through Cloudflare before coming back to your house. Functionally fine; latency-wise wasteful.

In Pi-hole admin → Settings → Local DNS Records, add:

```
www.{DOMAIN}    {LAN_IP}
```

Internal queries are then answered directly with your LAN IP, bypassing the tunnel. External queries still hit Cloudflare and the tunnel.

### Extending the gate to other services

The auth gate is reusable. To put another web service behind it (e.g. exposing Sonarr externally):

1. **Widen the cookie's `Domain` attribute** from `www.{DOMAIN}` to `{DOMAIN}` so it's sent to all subdomains. One-line change in `auth/server.ts`:
   ```ts
   const COOKIE_DOMAIN = DOMAIN;
   ```
2. **Factor the directive into a Caddyfile snippet** so each protected service is a one-liner:
   ```caddy
   (auth) {
       forward_auth auth:8000 {
           uri /verify
           copy_headers Cookie
       }
   }

   sonarr.{$DOMAIN} {
       import auth
       reverse_proxy sonarr:8989
   }
   ```
3. **Add an ingress rule** to `/etc/cloudflared/config.yml`:
   ```yaml
   - hostname: sonarr.{DOMAIN}
     service: https://localhost:443
     originRequest:
       originServerName: sonarr.{DOMAIN}
   ```
4. **Route the DNS** and reload:
   ```sh
   cloudflared tunnel route dns homelab "sonarr.${DOMAIN}"
   sudo systemctl restart cloudflared
   docker compose restart caddy
   ```

Which services fit this model — and which don't:

| Service | Cookie gate? | Why |
|---------|--------------|-----|
| Dashboard (`www`) | Yes | Browser-only, no native app. |
| Sonarr / Radarr / Prowlarr / Bazarr | Yes | Pure web UI + REST. Internal containers reach each other via the docker network (`sonarr:8989`, not via Caddy), so cross-service API calls aren't affected. |
| qBittorrent | Yes | Web UI only. |
| Jellyfin | No | Native apps (Android TV, iOS) authenticate with bearer tokens, not cookies — they'd bounce off the gate on every API call. |
| Navidrome | No | Subsonic-API clients (Symfonium, DSub) authenticate via query-param tokens. |
| Home Assistant | No | The Companion app uses long-lived bearer tokens; mobile push relies on the app reaching HA. |

For services that don't fit, either leave them LAN-only or pick a different external-access pattern (Cloudflare Access service tokens, Tailscale, WireGuard).

### What this protects (and doesn't)

- **Protects:** external HTTP access without a valid HMAC cookie. The cookie can only be obtained from inside the LAN, so an attacker who knows your domain still can't reach the dashboard from the internet.
- **Doesn't protect:** anyone who has a cookie. The cookie carries no per-user identity, can't be revoked individually, and only expires on time. If a device with a cookie is lost or compromised, rotate `AUTH_SECRET` to invalidate every cookie at once.
- **Implicit trust assumption:** anyone on the LAN can mint a cookie. If your LAN includes a guest wifi you don't trust, isolate it on a separate VLAN or skip the LAN-bootstrap pattern entirely.

## File structure

```
.env                    # Host paths, UIDs, timezone, domain
.api_keys               # API keys and Cloudflare token (gitignored)
docker-compose.yml      # All service definitions
Caddyfile               # Reverse proxy + HTTPS config
dashboard/              # Bun web app — the Movie Bot UI
auth/                   # Bun cookie-minter for the LAN-bootstrapped auth gate (External access section)
tv/                     # Bun + SQLite IPTV playlist manager (channel CRUD, M3U import, /playlist.m3u render)
  data/tv.db            #   single-file SQLite db, committed to the repo as a soft backup
  server.ts             #   API + M3U parser/renderer (POST /api/channels is the "add one channel" hook)
  public/               #   SPA: drag-to-reorder, inline edit, bulk ops, hls.js test player
movie-bot-requests/     # Cron worker that consumes the prompt queue (runs every minute)
movie-bot-download-triage/ # Cron worker that triages the qBit queue + promotes fresh requests (every 4h)
movie-bot-recommendations/ # Cron worker that generates weekly film recs (Sunday 06:00 UTC)
movie-bot-double-features/ # Cron worker that proposes double-feature pairings (nightly 03:00 UTC)
movie-bot-data/         # Movie Bot runtime state (gitignored contents)
  pending/              #   inbox: dashboard drops new .txt prompts here; cron consumes
  completed-requests/   #   archive: processed .txt + .out pairs
  completed-triage-runs/#   markdown reports from the triage cron
  completed-recs-runs/  #   markdown reports from the recs cron
  completed-double-feature-runs/ # markdown reports from the double-features cron
  double-features/      #   active (non-dismissed) double-feature suggestions, one .md per pairing
  dismissed-double-features/ # dismissed pairings — bot reads these to avoid repeating
  recommendations.jsonl #   recs feed consumed by the dashboard Recs panel
  movie-thoughts.jsonl  #   per-movie user thoughts/ratings feeding future recs
  youtube-grabs/        #   pending/completed job records for the YouTube panel
  sweep-logs/           #   missing/cutoff cron logs
caddy/                  # Custom Caddy build with Cloudflare DNS plugin
openresty/              # jellyfin-proxy config (rewrites PlaybackInfo to strip HEVC)
scripts/                # backup/restore + library sweeps + youtube-grab worker
config/                 # Per-container config volumes (gitignored)
settings/               # Exported service settings (safe to commit)
```
