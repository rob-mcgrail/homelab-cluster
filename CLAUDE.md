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
- `.api_keys` — gitignored, ENV-style file with API keys and URLs for each service. Source this to interact with service APIs (e.g. `source .api_keys && curl -H "X-Api-Key: $SONARR_API_KEY" "$SONARR_URL/api/v3/system/status"`). qBittorrent uses subnet whitelist auth (172.20.0.0/16) so no credentials are needed from the host.

## Ports

| Service      | Port |
|-------------|------|
| Jellyfin    | 8096 |
| Sonarr      | 8989 |
| Radarr      | 7878 |
| Prowlarr    | 9696 |
| qBittorrent | 8080 |
