# media-cluster

Docker Compose stack for a home media server: Jellyfin, Sonarr, Radarr, Prowlarr, qBittorrent.

## Setup

Follows the [Servarr Docker Guide](https://wiki.servarr.com/docker-guide) path conventions:
- `/data` inside containers is the shared root
- Sonarr/Radarr mount the full `/data` tree (enables hardlinks + atomic moves)
- qBittorrent only sees `/data/torrents`
- Jellyfin only sees `/data/media`

## Key files

- `.env` — all host paths, user/group IDs, timezone. Change `DATA_ROOT` when migrating to a new drive.
- `docker-compose.yml` — service definitions
- `config/` — gitignored, holds per-container config volumes

## Ports

| Service      | Port |
|-------------|------|
| Jellyfin    | 8096 |
| Sonarr      | 8989 |
| Radarr      | 7878 |
| Prowlarr    | 9696 |
| qBittorrent | 8080 |
