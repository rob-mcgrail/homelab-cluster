# jellyfin-proxy

An openresty sidecar that sits between Caddy and Jellyfin *only* on the `jellyfin-force-transcode.{DOMAIN}` subdomain. Its job: intercept `POST /Items/*/PlaybackInfo` and strip `hevc`/`h265` from `DirectPlayProfiles`, `DirectStreamProfiles`, and `TranscodingProfiles` in the client's `DeviceProfile` body before forwarding to Jellyfin.

## Why it exists

The Android TV Jellyfin client (`Jellyfin Android TV`) advertises HEVC direct-play support but its hardware decoder stutters on real content. The app has no "disable direct play" toggle and a user-level bitrate cap is too blunt (hurts all clients and all sources).

Stripping HEVC from the advertised device profile forces Jellyfin to pick H.264 transcoding (via QSV on the UHD 770), which plays smoothly.

## Architecture

- `jellyfin.{DOMAIN}` → Caddy → `jellyfin:8096` (unchanged, direct)
- `jellyfin-force-transcode.{DOMAIN}` → Caddy → `jellyfin-proxy:8096` (openresty) → `jellyfin:8096`
- Host LAN `:8096` → `jellyfin:8096` (unchanged, direct)

Point a specific client at the force-transcode subdomain to opt it into transcoding; all others keep direct-playing whatever works. Zero impact on clients that aren't pointed at the subdomain.

## The filter

`default.conf` hooks `/Items/*/PlaybackInfo` with an `access_by_lua_block`. It reads the POST body, parses the JSON, removes `hevc`/`h265` from the `VideoCodec` field of every video-type entry in:

- `DirectPlayProfiles` — "play the file as-is"
- `DirectStreamProfiles` — "copy codec, remux container"
- `TranscodingProfiles` — "what codecs the client accepts as transcoded output"

It rewrites the body and `proxy_pass`es upstream to Jellyfin with the modified payload. Everything else proxies through untouched.

## Gotchas

1. **`cjson` round-trips empty arrays as empty objects by default.** Jellyfin rejects the payload silently (client receives a broken response and gives up without retrying). The fix in `default.conf` is `cjson.decode_array_with_array_mt(true)` — tags decoded arrays with a metatable so they re-encode as arrays.

2. **`TranscodingProfiles` must also have `hevc` stripped.** Android TV's profile lists `"VideoCodec": "hevc,h264"` for transcoding — Jellyfin picks the first compatible codec (hevc) and would happily transcode HEVC→HEVC, sending HEVC back to the client (still stuttering). Filtering `hevc` out leaves `h264` as the only option.

3. **Schema drift is a silent failure.** If Jellyfin ever renames `VideoCodec` or restructures `DeviceProfile`, the filter silently no-ops and HEVC stutter returns. Not a hard break, but worth knowing. First sign: `docker logs -f jellyfin-proxy` stops showing lua errors that previously logged HEVC removal.

4. **Location ordering matters.** nginx regex locations match in order of definition. If adding a new `location ~` block that could also match `/Items/*/PlaybackInfo`, make sure the filter block comes first, or the filter will never run.

## Extending

To also strip AV1 (or any other codec), edit the codec check in `filter_hevc()`:

```lua
if c ~= "hevc" and c ~= "h265" and c ~= "av1" then
    table.insert(codecs, codec)
end
```

Then `docker compose restart jellyfin-proxy`. Config syntax check: `docker exec jellyfin-proxy /usr/local/openresty/bin/openresty -t`.

## Debugging

To see what the client actually sends, temporarily add body logging inside the filter block:

```lua
ngx.log(ngx.ERR, "[hevc-filter] BODY-BEFORE: " .. body)
-- ... filter runs ...
ngx.log(ngx.ERR, "[hevc-filter] BODY-AFTER: " .. new_body)
```

Then `docker compose restart jellyfin-proxy` and `docker logs -f jellyfin-proxy`. nginx caps individual log lines at ~8 KB so long `DeviceProfile` payloads will be truncated — enough for codec debugging, not enough for full structure.

To see what Jellyfin ended up doing (direct play vs transcode, output codec/bitrate, HW accel), check the active session via API:

```sh
source .api_keys && curl -s -H "X-MediaBrowser-Token: $JELLYFIN_API_KEY" "http://localhost:8096/Sessions" | python3 -m json.tool | grep -iE 'playmethod|transcod|nowplay|video'
```

Expected for a forced-transcode session: `PlayMethod: Transcode`, `TranscodeReasons: ['VideoCodecNotSupported']`, `VideoCodec: h264`, `HardwareAccelerationType: qsv`.
