# media-cluster

Docker Compose stack for a home media server: Jellyfin, Sonarr, Radarr, Prowlarr, qBittorrent, Bazarr.

## Setup

Follows the [Servarr Docker Guide](https://wiki.servarr.com/docker-guide) path conventions:
- `/data` inside containers is the shared root
- Sonarr/Radarr mount the full `/data` tree (enables hardlinks + atomic moves)
- qBittorrent only sees `/data/torrents`
- Jellyfin only sees `/data/media`

## Storage

Data lives on one or more USB storage drives pooled via mergerfs:
- `/mnt/disk1` — ext4 USB drive (add more as `/mnt/disk2`, etc.)
- `/srv/data` — mergerfs mount pooling `/mnt/disk1` (and future drives)
- `DATA_ROOT=/srv/data` in `.env` — all containers reference this

Both the disk mount and mergerfs pool are in `/etc/fstab` with `nofail` so the system boots even if the USB drive isn't plugged in.

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

## jellyfin-proxy

Openresty sidecar that rewrites `PlaybackInfo` on the `jellyfin-force-transcode.{DOMAIN}` subdomain to force HEVC transcoding for clients whose decoders stutter on real HEVC (Android TV). See `openresty/README.md` for the why, architecture, and gotchas.

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
| Rob4K    | Movies (when disk space allows) | ~36 GB          | 1080p + 4K, no remuxes; 4K preferred=160, max=200 MB/min |

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
