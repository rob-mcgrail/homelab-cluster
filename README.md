# homelab-cluster

Docker Compose stack for a home media server with a mobile-first dashboard and an AI-powered movie bot.

**Services:** Jellyfin, Sonarr, Radarr, Prowlarr, qBittorrent, Bazarr, Navidrome (music streaming), Home Assistant (Reolink cameras + floodlight automation), Pi-hole (network-wide DNS + ad-blocking + optional DHCP), Tube Archivist (YouTube channel archiver, Jellyfin-integrated for kids' content), Caddy (reverse proxy), jellyfin-proxy (HEVC force-transcode shim), Dashboard (Movie Bot)

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
- **`run-triage.sh`** — every 4 hours, reviews the qBittorrent queue and recent user requests: pauses + re-searches early-stalled torrents, parks mostly-done stalls and retries them after 12h, auto-retires torrents stuck for >7 days (removes + blocklists dead release, triggers fresh search), cleans up orphaned `missingFiles` torrents (with a safety cap so a transient mount failure doesn't nuke everything), and priority-boosts fresh small-batch requests. See `movie-bot-download-triage/triage-prompt.txt` for the full decision framework.
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
| Tube Archivist | `https://tubearchivist.yourdomain.org` |

Services are also available on their original ports via IP for direct access.

## Dashboard

The dashboard is a mobile-first web app at `https://www.yourdomain.org` with 8 swipeable panels (left → right):

1. **Double Features** (emerald green, otter) — thematic double-feature pairings from the Jellyfin "Films" library generated by `run-double-features.sh`. Dismissing a suggestion moves it to a dismissed folder so the bot won't re-propose it.
2. **Recs** (teal, birds) — weekly AI film recommendations from `run-recs.sh` with thumbs up/down feedback that feeds future rec generations
3. **History** (green, fish) — recent Movie Bot prompts and responses
4. **Movie Bot** (orange, crab) — submit requests to the AI
5. **Downloads** (blue, octopus) — active torrents. Filters: **Downloading** (qBit-active — including stalled), **Seeding** (done / queued-UP), **Triaged** (anything with a `triage-*` tag, plus freshly-queued downloads that haven't become active yet). Triaged items show a sub-badge with the specific state (`early-stall`, `parked`, `retrying`, `queued`, `stopped`, `error`, `missing`) and how long they've been in it.
6. **Server** (purple, bugs) — CPU load, memory, swap, disk usage, plus active Jellyfin streams with transcoding / source-vs-output detail
7. **Floodlights** (coral, fox) — Reolink floodlight cam controls via Home Assistant: per-cam + "All" toggles, live MJPEG previews of each cam (tap for fullscreen HD), recent motion-triggered HD clips (paired by event, side-by-side playback), a two-tap **PANIC** button (lights + sirens), and a single-tap **SILENCE SIRENS** button to undo the siren part. See `homeassistant/NOTES.md` for the recording pipeline + presence-aware skip logic.
8. **Services** (yellow, bees) — quick links to all service dashboards

#### Optional: Pi-hole panel

A red-themed Pi-hole panel (skulls + bats) can be appended to the swipeable list via the `PIHOLE_PANEL` env var on the dashboard service. Values:

- `off` (default) — panel hidden.
- `blocks` — top 20 blocked domains in the last 24h. Works with any DHCP topology.
- `clients` — per-client allowed/blocked counts. Only useful when Pi-hole itself is the DHCP server and can see individual client IPs; under the default topology (router does DHCP, DNS is proxied through a single IP) all queries look like they come from the router, so this view is empty.

Change the value in `docker-compose.yml` and `docker compose up -d dashboard` to apply.

## Storage

Data lives on a drive pool via mergerfs. See `CLAUDE.md` for details on the storage setup and how to add drives.

## File structure

```
.env                    # Host paths, UIDs, timezone, domain
.api_keys               # API keys and Cloudflare token (gitignored)
docker-compose.yml      # All service definitions
Caddyfile               # Reverse proxy + HTTPS config
dashboard/              # Bun web app — the Movie Bot UI
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
caddy/                  # Custom Caddy build with Cloudflare DNS plugin
openresty/              # jellyfin-proxy config (rewrites PlaybackInfo to strip HEVC)
scripts/                # backup/restore-settings shell scripts
config/                 # Per-container config volumes (gitignored)
settings/               # Exported service settings (safe to commit)
```
