#!/usr/bin/env bash
set -euo pipefail

# Restores service settings from JSON files exported by backup-settings.sh.
# Requires services to be running and .api_keys to be populated.
#
# NOTE: This restores profiles, formats, and definitions. It does NOT restore
# download client passwords, provider credentials, or API keys — you'll need
# to re-enter those in each service's UI after restoring.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
SETTINGS_DIR="$REPO_ROOT/settings"
source "$REPO_ROOT/.api_keys"

if [ ! -d "$SETTINGS_DIR" ]; then
    echo "Error: $SETTINGS_DIR not found. Run backup-settings.sh first."
    exit 1
fi

echo "==> Radarr"

# Custom formats first (profiles reference them)
for cf in $(jq -c '.[]' "$SETTINGS_DIR/radarr/custom-formats.json"); do
    name=$(echo "$cf" | jq -r '.name')
    payload=$(echo "$cf" | jq 'del(.id)')
    code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
        -H "X-Api-Key: $RADARR_API_KEY" -H "Content-Type: application/json" \
        -d "$payload" "$RADARR_URL/api/v3/customformat")
    echo "    custom format '$name': $code"
done

# Quality definitions
for qd in $(jq -c '.[]' "$SETTINGS_DIR/radarr/quality-definitions.json"); do
    id=$(echo "$qd" | jq '.id')
    curl -s -o /dev/null -X PUT \
        -H "X-Api-Key: $RADARR_API_KEY" -H "Content-Type: application/json" \
        -d "$qd" "$RADARR_URL/api/v3/qualitydefinition/$id"
done
echo "    quality definitions: restored"

# Root folders
for rf in $(jq -c '.[]' "$SETTINGS_DIR/radarr/root-folders.json"); do
    path=$(echo "$rf" | jq -r '.path')
    code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
        -H "X-Api-Key: $RADARR_API_KEY" -H "Content-Type: application/json" \
        -d "$rf" "$RADARR_URL/api/v3/rootfolder")
    echo "    root folder '$path': $code"
done

# Naming
curl -s -o /dev/null -X PUT \
    -H "X-Api-Key: $RADARR_API_KEY" -H "Content-Type: application/json" \
    -d @"$SETTINGS_DIR/radarr/naming.json" "$RADARR_URL/api/v3/naming"
echo "    naming: restored"

echo "==> Sonarr"

for cf in $(jq -c '.[]' "$SETTINGS_DIR/sonarr/custom-formats.json"); do
    name=$(echo "$cf" | jq -r '.name')
    payload=$(echo "$cf" | jq 'del(.id)')
    code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
        -H "X-Api-Key: $SONARR_API_KEY" -H "Content-Type: application/json" \
        -d "$payload" "$SONARR_URL/api/v3/customformat")
    echo "    custom format '$name': $code"
done

for qd in $(jq -c '.[]' "$SETTINGS_DIR/sonarr/quality-definitions.json"); do
    id=$(echo "$qd" | jq '.id')
    curl -s -o /dev/null -X PUT \
        -H "X-Api-Key: $SONARR_API_KEY" -H "Content-Type: application/json" \
        -d "$qd" "$SONARR_URL/api/v3/qualitydefinition/$id"
done
echo "    quality definitions: restored"

for rf in $(jq -c '.[]' "$SETTINGS_DIR/sonarr/root-folders.json"); do
    path=$(echo "$rf" | jq -r '.path')
    code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
        -H "X-Api-Key: $SONARR_API_KEY" -H "Content-Type: application/json" \
        -d "$rf" "$SONARR_URL/api/v3/rootfolder")
    echo "    root folder '$path': $code"
done

curl -s -o /dev/null -X PUT \
    -H "X-Api-Key: $SONARR_API_KEY" -H "Content-Type: application/json" \
    -d @"$SETTINGS_DIR/sonarr/naming.json" "$SONARR_URL/api/v3/naming"
echo "    naming: restored"

echo "==> qBittorrent"
curl -s -X POST "$QBITTORRENT_URL/api/v2/app/setPreferences" \
    --data-urlencode "json=$(cat "$SETTINGS_DIR/qbittorrent/preferences.json")"
echo "    preferences: restored"

for cat_name in $(jq -r 'keys[]' "$SETTINGS_DIR/qbittorrent/categories.json"); do
    save_path=$(jq -r ".\"$cat_name\".savePath" "$SETTINGS_DIR/qbittorrent/categories.json")
    curl -s -X POST "$QBITTORRENT_URL/api/v2/torrents/createCategory" \
        -d "category=$cat_name&savePath=$save_path" 2>/dev/null
done
echo "    categories: restored"

echo ""
echo "Done! Settings restored."
echo ""
echo "Manual steps remaining:"
echo "  - Re-enter download client passwords in Sonarr/Radarr"
echo "  - Re-enter subtitle provider credentials in Bazarr"
echo "  - Re-add Prowlarr app connections (Sonarr/Radarr API keys change on reinstall)"
