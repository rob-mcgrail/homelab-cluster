#!/usr/bin/env bash
set -euo pipefail

# Creates the media group and per-service users, then writes their
# UIDs/GID into .env so docker-compose picks them up.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
DATA_ROOT=$(grep '^DATA_ROOT=' "$ENV_FILE" | cut -d= -f2)
CONFIG_ROOT_RAW=$(grep '^CONFIG_ROOT=' "$ENV_FILE" | cut -d= -f2)

# Resolve relative config path against script dir
if [[ "$CONFIG_ROOT_RAW" == ./* ]]; then
    CONFIG_ROOT="$SCRIPT_DIR/${CONFIG_ROOT_RAW#./}"
else
    CONFIG_ROOT="$CONFIG_ROOT_RAW"
fi

GROUP_NAME=media
SERVICES=(jellyfin sonarr radarr prowlarr qbittorrent bazarr)

echo "==> Creating shared group: $GROUP_NAME"
if ! getent group "$GROUP_NAME" > /dev/null 2>&1; then
    sudo groupadd "$GROUP_NAME"
fi
PGID=$(getent group "$GROUP_NAME" | cut -d: -f3)
echo "    GID: $PGID"

echo ""
echo "==> Creating service users"
declare -A PUIDS
for svc in "${SERVICES[@]}"; do
    if ! id "$svc" > /dev/null 2>&1; then
        sudo useradd -r -s /usr/sbin/nologin -g "$GROUP_NAME" "$svc"
    else
        # Ensure existing user is in the media group
        sudo usermod -aG "$GROUP_NAME" "$svc"
    fi
    PUIDS[$svc]=$(id -u "$svc")
    echo "    $svc => UID ${PUIDS[$svc]}"
done

# Also add the current user to the media group
echo ""
echo "==> Adding $(whoami) to $GROUP_NAME group"
sudo usermod -aG "$GROUP_NAME" "$(whoami)"

# Add jellyfin to the render group for Intel QSV hardware acceleration
echo ""
echo "==> Adding jellyfin to render group (Intel QSV)"
sudo usermod -aG render jellyfin

echo ""
echo "==> Writing IDs to $ENV_FILE"
sed -i "s/^PGID=.*/PGID=$PGID/" "$ENV_FILE"
sed -i "s/^PUID_JELLYFIN=.*/PUID_JELLYFIN=${PUIDS[jellyfin]}/" "$ENV_FILE"
sed -i "s/^PUID_SONARR=.*/PUID_SONARR=${PUIDS[sonarr]}/" "$ENV_FILE"
sed -i "s/^PUID_RADARR=.*/PUID_RADARR=${PUIDS[radarr]}/" "$ENV_FILE"
sed -i "s/^PUID_PROWLARR=.*/PUID_PROWLARR=${PUIDS[prowlarr]}/" "$ENV_FILE"
sed -i "s/^PUID_QBITTORRENT=.*/PUID_QBITTORRENT=${PUIDS[qbittorrent]}/" "$ENV_FILE"
sed -i "s/^PUID_BAZARR=.*/PUID_BAZARR=${PUIDS[bazarr]}/" "$ENV_FILE"

echo ""
echo "==> Creating data directories"
sudo mkdir -p "$DATA_ROOT"/{torrents/{movies,tv,music},media/{movies,tv,music,kids/{movies,tv}}}
sudo chown -R "$(whoami):$GROUP_NAME" "$DATA_ROOT"
sudo chmod -R 775 "$DATA_ROOT"

echo ""
echo "==> Creating config directories"
for svc in "${SERVICES[@]}"; do
    sudo mkdir -p "$CONFIG_ROOT/$svc"
    sudo chown -R "${PUIDS[$svc]}:$PGID" "$CONFIG_ROOT/$svc"
    sudo chmod -R 750 "$CONFIG_ROOT/$svc"
done

echo ""
echo "Done! Review .env, then run: docker compose up -d"
echo "(You may need to log out and back in for the $GROUP_NAME group to take effect.)"
