# media-cluster

Docker Compose stack for a home media server with a mobile-first dashboard and an AI-powered movie bot.

**Services:** Jellyfin, Sonarr, Radarr, Prowlarr, qBittorrent, Bazarr, Caddy (reverse proxy), jellyfin-proxy (HEVC force-transcode shim), Dashboard (Movie Bot)

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
sudo mergerfs -o defaults,allow_other,use_ino,cache.files=partial,dropcacheonclose=true,category.create=mfs /mnt/disk1 /srv/data
```

See `CLAUDE.md` for fstab entries and adding more drives.

### 3. Clone and configure

```sh
git clone <repo-url> && cd media-cluster
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
./restore-settings.sh
```

This restores:
- **Radarr/Sonarr** — custom formats, quality profiles, quality definitions, root folders, naming
- **qBittorrent** — preferences, categories

After restoring, you'll need to manually:
- Re-enter download client passwords in Sonarr/Radarr
- Re-enter subtitle provider credentials in Bazarr
- Re-add Prowlarr app connections (API keys change on reinstall)

To back up settings after making changes:

```sh
./backup-settings.sh
```

This exports current settings to `settings/` (secrets are stripped).

### 8. Movie Bot cron

Add to your crontab (`crontab -e`):

```
* * * * * /path/to/media-cluster/run-prompt.sh
```

This checks for new prompts from the dashboard every minute and runs Claude Code to process them.

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

Services are also available on their original ports via IP for direct access.

## Dashboard

The dashboard is a mobile-first web app at `https://www.yourdomain.org` with 5 swipeable panels:

1. **History** (green, fish) — recent Movie Bot prompts and responses
2. **Movie Bot** (orange, crab) — submit requests to the AI
3. **Downloads** (blue, octopus) — active torrents with filters
4. **Server** (purple, bugs) — CPU load, memory, swap, disk usage
5. **Services** (yellow, bees) — quick links to all service dashboards

On desktop (900px+), all panels display in a 3-column grid with auto-polling.

## Storage

Data lives on a drive pool via mergerfs. See `CLAUDE.md` for details on the storage setup and how to add drives.

## File structure

```
.env                    # Host paths, UIDs, timezone, domain
.api_keys               # API keys and Cloudflare token (gitignored)
docker-compose.yml      # All service definitions
Caddyfile               # Reverse proxy + HTTPS config
prompt-template.txt     # System prompt for Movie Bot
run-prompt.sh           # Cron script that runs Claude Code
dashboard/              # Bun web app (Movie Bot dashboard)
caddy/                  # Custom Caddy build with Cloudflare DNS plugin
openresty/              # jellyfin-proxy config (rewrites PlaybackInfo to strip HEVC)
config/                 # Per-container config volumes (gitignored)
prompts/                # Prompt queue for Movie Bot (gitignored)
settings/               # Exported service settings (safe to commit)
```
