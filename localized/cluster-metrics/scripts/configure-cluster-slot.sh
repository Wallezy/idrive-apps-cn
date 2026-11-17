#!/bin/sh
# configure-cluster-slot.sh - verify or restore cluster-render's default 1920x720 panel slot (0x203).
#
# Real-car KOMBI4 finding:
#   - Default `panel_slot = 0x203` (`panel_scene_id = 0x010004f8`) in cluster-render is already
#     alpha-transparent over BMW's stock gauges, right-side Power Gauge needle, Media display,
#     built-in cluster map, and waze-on-cluster (0x100) while running alongside HUD (0x323)!
#   - Overriding `panel_slot = 0x202` hijacks KOMBI4's right-wing Power Gauge & Media slot.
#
# Usage on the MGU head unit over SSH:
#   sh scripts/configure-cluster-slot.sh --status
#   sh scripts/configure-cluster-slot.sh --revert

set -eu

CONF_DIR="${CLUSTER_RENDER_CONF_DIR:-/var/opt/cluster-render}"
LOCAL_CONF="$CONF_DIR/cluster-render.local.conf"
BACKUP_CONF="$CONF_DIR/cluster-render.local.conf.bak.cluster_metrics"
MANAGED_MARKER="# managed-by: idrive7-cluster-metrics"

usage() {
    cat <<EOF
Usage: $0 [--status | --revert]

Commands:
  --status   Show current cluster-render slot configuration
  --revert   Remove legacy $LOCAL_CONF (e.g. panel_slot = 0x202) and restart cluster-render
             so default transparent panel_slot = 0x203 + Power Gauge + Media work out-of-the-box.
EOF
}

restart_service() {
    if [ "${CLUSTER_RENDER_NO_SYSTEMCTL:-0}" = "1" ]; then
        echo "skipping systemctl restart (CLUSTER_RENDER_NO_SYSTEMCTL=1)"
        return 0
    fi
    if command -v systemctl >/dev/null 2>&1; then
        if systemctl list-unit-files 2>/dev/null | grep -q "cluster-render"; then
            echo "Restarting cluster-render..."
            systemctl restart cluster-render
            systemctl status cluster-render --no-pager -l | head -n 12 || true
            return 0
        fi
    fi
    echo "systemctl cluster-render unit not found; restart cluster-render manually if running on car."
}

cmd_status() {
    echo "Config dir: $CONF_DIR"
    if [ -f "$CONF_DIR/cluster-render.conf" ]; then
        echo "--- cluster-render.conf (excerpt) ---"
        grep -E "^(panel_slot|panel_scene_id|map_slot|map_scene_id|hud_slot|hud_scene_id|guide_hold)" "$CONF_DIR/cluster-render.conf" || true
    fi
    if [ -f "$LOCAL_CONF" ]; then
        echo "--- $LOCAL_CONF ---"
        cat "$LOCAL_CONF"
        if grep -qE "^[[:space:]]*panel_slot[[:space:]]*=[[:space:]]*0x20[12]" "$LOCAL_CONF"; then
            echo "WARNING: panel_slot 0x202/0x201 hijacks BMW's right-side Power Gauge & Media display!"
            echo "Run '$0 --revert' to restore default transparent panel_slot = 0x203."
        fi
    else
        echo "--- $LOCAL_CONF not present (GOOD: using default transparent panel_slot = 0x203, scene 0x010004f8) ---"
    fi
}

cmd_revert() {
    if [ -f "$BACKUP_CONF" ]; then
        mv "$BACKUP_CONF" "$LOCAL_CONF"
        echo "Restored backup to $LOCAL_CONF"
        restart_service
    elif [ -f "$LOCAL_CONF" ]; then
        rm -f "$LOCAL_CONF"
        echo "Removed $LOCAL_CONF (restored default transparent panel_slot = 0x203)"
        restart_service
    else
        echo "Already clean ($LOCAL_CONF does not exist; default panel_slot = 0x203 is active)."
    fi
}

case "${1:---status}" in
    --status)
        cmd_status
        ;;
    --revert|--fix)
        cmd_revert
        ;;
    -h|--help)
        usage
        ;;
    *)
        usage >&2
        exit 2
        ;;
esac
