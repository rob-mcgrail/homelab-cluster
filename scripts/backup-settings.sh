#!/usr/bin/env bash
set -euo pipefail

# Exports service settings to JSON files for version control.
# No secrets are included — API keys are stripped from the output.
# To restore, use restore-settings.sh.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
SETTINGS_DIR="$REPO_ROOT/settings"
source "$REPO_ROOT/.api_keys"

mkdir -p "$SETTINGS_DIR"/{radarr,sonarr,prowlarr,bazarr,qbittorrent,jellyfin,pihole}

echo "==> Radarr"
curl -s -H "X-Api-Key: $RADARR_API_KEY" "$RADARR_URL/api/v3/qualityprofile" | jq '.' > "$SETTINGS_DIR/radarr/quality-profiles.json"
curl -s -H "X-Api-Key: $RADARR_API_KEY" "$RADARR_URL/api/v3/qualitydefinition" | jq '.' > "$SETTINGS_DIR/radarr/quality-definitions.json"
curl -s -H "X-Api-Key: $RADARR_API_KEY" "$RADARR_URL/api/v3/customformat" | jq '.' > "$SETTINGS_DIR/radarr/custom-formats.json"
curl -s -H "X-Api-Key: $RADARR_API_KEY" "$RADARR_URL/api/v3/rootfolder" | jq '[.[] | {path}]' > "$SETTINGS_DIR/radarr/root-folders.json"
curl -s -H "X-Api-Key: $RADARR_API_KEY" "$RADARR_URL/api/v3/downloadclient" | jq '[.[] | del(.fields[] | select(.name == "password") | .value)]' > "$SETTINGS_DIR/radarr/download-clients.json"
curl -s -H "X-Api-Key: $RADARR_API_KEY" "$RADARR_URL/api/v3/naming" | jq '.' > "$SETTINGS_DIR/radarr/naming.json"
echo "    quality-profiles, quality-definitions, custom-formats, root-folders, download-clients, naming"

echo "==> Sonarr"
curl -s -H "X-Api-Key: $SONARR_API_KEY" "$SONARR_URL/api/v3/qualityprofile" | jq '.' > "$SETTINGS_DIR/sonarr/quality-profiles.json"
curl -s -H "X-Api-Key: $SONARR_API_KEY" "$SONARR_URL/api/v3/qualitydefinition" | jq '.' > "$SETTINGS_DIR/sonarr/quality-definitions.json"
curl -s -H "X-Api-Key: $SONARR_API_KEY" "$SONARR_URL/api/v3/customformat" | jq '.' > "$SETTINGS_DIR/sonarr/custom-formats.json"
curl -s -H "X-Api-Key: $SONARR_API_KEY" "$SONARR_URL/api/v3/rootfolder" | jq '[.[] | {path}]' > "$SETTINGS_DIR/sonarr/root-folders.json"
curl -s -H "X-Api-Key: $SONARR_API_KEY" "$SONARR_URL/api/v3/downloadclient" | jq '[.[] | del(.fields[] | select(.name == "password") | .value)]' > "$SETTINGS_DIR/sonarr/download-clients.json"
curl -s -H "X-Api-Key: $SONARR_API_KEY" "$SONARR_URL/api/v3/naming" | jq '.' > "$SETTINGS_DIR/sonarr/naming.json"
echo "    quality-profiles, quality-definitions, custom-formats, root-folders, download-clients, naming"

echo "==> Prowlarr"
curl -s -H "X-Api-Key: $PROWLARR_API_KEY" "$PROWLARR_URL/api/v1/indexer" | jq '[.[] | {name, definitionName, protocol, fields: [.fields[] | select(.privacy != "apiKey" and .privacy != "password") | {name, value}]}]' > "$SETTINGS_DIR/prowlarr/indexers.json"
curl -s -H "X-Api-Key: $PROWLARR_API_KEY" "$PROWLARR_URL/api/v1/applications" | jq '[.[] | {name, implementation, syncLevel}]' > "$SETTINGS_DIR/prowlarr/apps.json"
curl -s -H "X-Api-Key: $PROWLARR_API_KEY" "$PROWLARR_URL/api/v1/indexerproxy" | jq '[.[] | {name, implementation, fields: [.fields[] | select(.privacy != "apiKey" and .privacy != "password") | {name, value}]}]' > "$SETTINGS_DIR/prowlarr/indexer-proxies.json"
echo "    indexers, apps, indexer-proxies"

echo "==> Bazarr"
curl -s -H "X-Api-Key: $BAZARR_API_KEY" "$BAZARR_URL/api/system/settings" | python3 -c "
import sys, json
settings = json.load(sys.stdin)
general = settings.get('general', {})
# Strip secrets
for key in ['external_webhook_password', 'external_webhook_username']:
    general.pop(key, None)
json.dump({
    'enabled_providers': general.get('enabled_providers', []),
    'languages': {k: v for k, v in general.items() if 'lang' in k.lower() or k in [
        'adaptive_searching', 'days_to_upgrade_subs', 'hi_extension',
        'embedded_subs_show_desired', 'upgrade_subs'
    ]}
}, sys.stdout, indent=2)
" > "$SETTINGS_DIR/bazarr/settings.json"
curl -s -H "X-Api-Key: $BAZARR_API_KEY" "$BAZARR_URL/api/system/languages/profiles" | jq '.' > "$SETTINGS_DIR/bazarr/language-profiles.json" 2>/dev/null || true
echo "    settings, language-profiles"

echo "==> qBittorrent"
curl -s "$QBITTORRENT_URL/api/v2/app/preferences" | jq '{
  save_path,
  temp_path_enabled,
  temp_path,
  max_ratio_enabled,
  max_ratio,
  max_ratio_act,
  max_seeding_time_enabled,
  max_seeding_time,
  max_inactive_seeding_time_enabled,
  max_inactive_seeding_time,
  up_limit,
  dl_limit,
  alt_up_limit,
  alt_dl_limit,
  scheduler_enabled,
  queueing_enabled,
  max_active_downloads,
  max_active_uploads,
  max_active_torrents,
  listen_port
}' > "$SETTINGS_DIR/qbittorrent/preferences.json"
curl -s "$QBITTORRENT_URL/api/v2/torrents/categories" | jq '.' > "$SETTINGS_DIR/qbittorrent/categories.json"
echo "    preferences, categories"

echo "==> Jellyfin"
curl -s -H "X-MediaBrowser-Token: $JELLYFIN_API_KEY" "$JELLYFIN_URL/Library/VirtualFolders" | jq '[.[] | {Name, CollectionType, Locations}]' > "$SETTINGS_DIR/jellyfin/libraries.json"
curl -s -H "X-MediaBrowser-Token: $JELLYFIN_API_KEY" "$JELLYFIN_URL/Users" | jq '[.[] | {Name, Policy: {IsAdministrator: .Policy.IsAdministrator, EnableAllFolders: .Policy.EnableAllFolders, EnabledFolders: .Policy.EnabledFolders, MaxStreamingBitrate: .Policy.MaxStreamingBitrate, RemoteClientBitrateLimit: .Policy.RemoteClientBitrateLimit}}]' > "$SETTINGS_DIR/jellyfin/users.json"
curl -s -H "X-MediaBrowser-Token: $JELLYFIN_API_KEY" "$JELLYFIN_URL/System/Configuration/encoding" | jq '{HardwareAccelerationType, EnableHardwareEncoding, EnableDecodingColorDepth10Hevc, EnableDecodingColorDepth10Vp9, VaapiDevice}' > "$SETTINGS_DIR/jellyfin/encoding.json"
echo "    libraries, users, encoding"

echo "==> Pi-hole"
PIHOLE_SID=$(curl -s -X POST "$PIHOLE_URL/api/auth" \
    -H "Content-Type: application/json" \
    -d "{\"password\":\"$FTLCONF_webserver_api_password\"}" \
    | jq -r '.session.sid // empty')
if [ -n "$PIHOLE_SID" ]; then
    curl -s -H "X-FTL-SID: $PIHOLE_SID" "$PIHOLE_URL/api/lists" \
        | jq '[.lists[] | {address, enabled, type, comment}]' > "$SETTINGS_DIR/pihole/adlists.json"
    curl -s -H "X-FTL-SID: $PIHOLE_SID" "$PIHOLE_URL/api/config/dhcp/hosts" \
        | jq '.config.dhcp.hosts' > "$SETTINGS_DIR/pihole/dhcp-hosts.json"
    curl -s -H "X-FTL-SID: $PIHOLE_SID" "$PIHOLE_URL/api/config/dns/upstreams" \
        | jq '.config.dns.upstreams' > "$SETTINGS_DIR/pihole/dns-upstreams.json"
    curl -s -X DELETE -H "X-FTL-SID: $PIHOLE_SID" "$PIHOLE_URL/api/auth" > /dev/null
    echo "    adlists, dhcp-hosts, dns-upstreams"
else
    echo "    skipped (auth failed — is Pi-hole reachable at $PIHOLE_URL?)"
fi

echo ""
echo "Done! Settings exported to $SETTINGS_DIR/"
