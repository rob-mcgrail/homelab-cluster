# homelab-cluster

Docker Compose stack for a home media server with a mobile-first dashboard and an AI-powered movie bot.

**Services:** Jellyfin, Sonarr, Radarr, Prowlarr, qBittorrent, Bazarr, Pi-hole (network-wide DNS + ad-blocking + optional DHCP), Caddy (reverse proxy), jellyfin-proxy (HEVC force-transcode shim), Dashboard (Movie Bot)

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
0 */2 * * * /path/to/homelab-cluster/movie-bot-download-triage/run-triage.sh
```

- **`run-prompt.sh`** — every minute, picks up new user prompts from the dashboard queue and runs Claude Code to process them.
- **`run-triage.sh`** — every 2 hours, reviews the qBittorrent queue and recent user requests: pauses + re-searches early-stalled torrents, parks mostly-done stalls and retries them after 12h, and priority-boosts fresh small-batch requests. See `movie-bot-download-triage/triage-prompt.txt` for the full decision framework.

### 9. Pi-hole (optional but recommended)

Pi-hole comes up with the rest of the stack and **already blocks ads across any client pointed at it for DNS**. The steps below are to actually route your LAN through it.

**Networking model:**

- Runs in `network_mode: host` so DHCP broadcasts (UDP 67) can reach it — bridge mode silently breaks for DHCP.
- Binds DNS (`:53`) only to specific interface IPs (`${LAN_IP}`, loopback, link-local v6), not `0.0.0.0` — this avoids conflict with Ubuntu's systemd-resolved on `127.0.0.53:53`. Host processes keep using resolved; LAN clients hit Pi-hole.
- Web UI runs on `:7001` (changed from default `:80` to keep out of Caddy's way); Caddy reverse-proxies to it at `https://pihole.{DOMAIN}/admin/`.

**Configure your router to use Pi-hole as DNS:**

In your router's admin UI, set **primary DNS to `${LAN_IP}`** (the IP of this box). If your router insists on two DNS entries, **duplicate** the same IP — don't add `1.1.1.1` as secondary, or clients will silently leak past Pi-hole on timeouts.

Devices pick up the new DNS on their next DHCP renewal. Toggle Wi-Fi on a client to force it immediately.

**Android gotcha:** each phone's *Settings → Network & Internet → Private DNS* must be **Off** or **Automatic**. Any other value (dns.google, 1dot1dot1dot1.cloudflare-dns.com) tunnels DNS over TLS past Pi-hole.

**Optionally move DHCP to Pi-hole** for per-device analytics and stable hostnames in the admin UI:

1. In Pi-hole admin (`https://pihole.{DOMAIN}/admin/settings/dhcp`), enable DHCP with the same range your router was using (typically `192.168.1.2`–`192.168.1.254`, router/gateway `192.168.1.1`, netmask `255.255.255.0`, lease `24h`).
2. **Recreate your static leases** in Pi-hole's *Static DHCP leases* section — at minimum for this server itself (so the Cloudflare wildcard target stays stable). You can also set them via CLI:
   ```sh
   docker exec pihole pihole-FTL --config dhcp.hosts '["AA:BB:CC:DD:EE:FF,192.168.1.33,SERVER"]'
   ```
3. In the router: uncheck **Use Router as DHCP Server**.
4. Toggle Wi-Fi on one device to verify it gets a lease from Pi-hole. If something breaks: re-enable router DHCP and disable Pi-hole DHCP — you're back where you started in under 30 seconds.

Existing devices keep their old leases until they expire (up to 24h) — toggling Wi-Fi on each device forces a faster transition.

**The server itself is both the DHCP server and a DHCP client** (Pi-hole runs here, but the host also needs an IP + DNS from somewhere). That creates a chicken-and-egg at boot: networkd brings up `eno1` and starts DHCP before Docker/Pi-hole is up to answer. Two pieces keep this clean:

1. **Infinite-lease reservation for the server's own MAC** in Pi-hole's static DHCP leases (`HW,IP,HOSTNAME,infinite`). Once the host has received this lease once, networkd caches `LIFETIME=infinite` and uses the IP immediately on every subsequent boot without needing a DHCP exchange — so Pi-hole doesn't have to be up early for the host to get an IP.

2. **systemd-resolved `FallbackDNS`** as a boot-window safety net — drop-in at `/etc/systemd/resolved.conf.d/10-fallback.conf`:
   ```
   [Resolve]
   FallbackDNS=1.1.1.1 1.0.0.1
   ```
   `FallbackDNS` only kicks in when the host has no DNS servers configured at all (early boot, before Pi-hole has bound `:53`). Once DHCP populates link DNS with Pi-hole, `FallbackDNS` is ignored — so ad/tracker blocking is fully preserved at steady state. It does *not* fall through on timeouts or NXDOMAIN; blocked domains stay blocked.

One caveat: if Pi-hole crashes mid-session after DHCP has already populated link DNS, the host's DNS goes with it — `FallbackDNS` does not help here because the link DNS list isn't empty, just unresponsive. For that case, restart the Pi-hole container.

**Recovery if Pi-hole dies** and DNS goes out for the whole LAN: set router DNS back to a public resolver (`1.1.1.1`) at the router admin page. Takes ~30 seconds, buys time to debug.

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
| Pi-hole | `https://pihole.yourdomain.org/admin` |

Services are also available on their original ports via IP for direct access.

## Dashboard

The dashboard is a mobile-first web app at `https://www.yourdomain.org` with 7 swipeable panels:

1. **History** (green, fish) — recent Movie Bot prompts and responses
2. **Movie Bot** (orange, crab) — submit requests to the AI
3. **Downloads** (blue, octopus) — active torrents with filters
4. **Server** (purple, bugs) — CPU load, memory, swap, disk usage
5. **Now Playing** (pink, jellyfish) — active Jellyfin streams with transcoding / source-vs-output detail
6. **Clients** (red, skulls + bats) — Pi-hole per-client allowed/blocked counts
7. **Services** (yellow, bees) — quick links to all service dashboards

On desktop (900px+), all panels display in a 4-column grid with auto-polling.

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
movie-bot-download-triage/ # Cron worker that triages the qBit queue + promotes fresh requests (every 2h)
movie-bot-data/         # Movie Bot runtime state (gitignored contents)
  pending/              #   inbox: dashboard drops new .txt prompts here; cron consumes
  completed-requests/   #   archive: processed .txt + .out pairs
  completed-triage-runs/#   markdown reports from the triage cron
caddy/                  # Custom Caddy build with Cloudflare DNS plugin
openresty/              # jellyfin-proxy config (rewrites PlaybackInfo to strip HEVC)
scripts/                # backup/restore-settings shell scripts
config/                 # Per-container config volumes (gitignored)
settings/               # Exported service settings (safe to commit)
```
