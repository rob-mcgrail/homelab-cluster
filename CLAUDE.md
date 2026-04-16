# media-cluster

Docker Compose stack for a home media server: Jellyfin, Sonarr, Radarr, Prowlarr, qBittorrent, Bazarr.

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
| Bazarr      | 6767 |

## Jellyfin libraries

| Library     | Type    | Path                   |
|-------------|---------|------------------------|
| Shows       | tvshows | `/data/media/tv`       |
| Movies      | movies  | `/data/media/movies`   |
| Kids TV     | tvshows | `/data/media/kids/tv`  |
| Kids Movies | movies  | `/data/media/kids/movies` |

## Quality profiles

| Profile  | Use for                        | Max (3hr movie) | Notes                        |
|----------|--------------------------------|-----------------|------------------------------|
| Rob1080  | TV, kids content, default      | ~10 GB          | 1080p only, HEVC allowed     |
| Rob4K    | Movies (when disk space allows) | ~30 GB          | 1080p + 4K, no remuxes       |

When adding new content: use **Rob1080** for all TV shows (Sonarr) and any kids content. Use **Rob4K** for recent releases, highly cinematic films (Scorsese, Kubrick, PTA, etc.), and anything where the visually quality is worth it. When in doubt for movies, prefer Rob4K.

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

# Search for a movie (by movie ID)
curl -s -X POST -H "X-Api-Key: $RADARR_API_KEY" -H "Content-Type: application/json" "$RADARR_URL/api/v3/command" -d '{"name": "MoviesSearch", "movieIds": [ID]}'
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
