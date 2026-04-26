#!/usr/bin/env bash
#
# patchright-scraper entrypoint. Conditionally starts Xvfb, x11vnc +
# websockify (noVNC), and mitmproxy + a durable disk-queue pusher,
# then exec's the Node service. Each background service is owned by
# this script; tini (PID 1) cleans them up when Node exits.

set -euo pipefail

log() {
    echo "[entrypoint] $*"
}

start_xvfb() {
    if [[ "${ENABLE_XVFB:-0}" != "1" ]]; then
        return
    fi
    local screen="${VIEWPORT:-1920x1080}x24"
    log "starting Xvfb on :99 (${screen})"
    Xvfb :99 -screen 0 "${screen}" -ac +extension RANDR -nolisten tcp &
    export DISPLAY=:99
    # Give Xvfb a moment to actually accept connections; cheap loop avoids
    # racing the browser launch.
    for _ in {1..20}; do
        xdpyinfo -display :99 >/dev/null 2>&1 && return
        sleep 0.1
    done
    log "Xvfb did not become ready"
    exit 1
}

start_vnc() {
    if [[ "${ENABLE_VNC:-0}" != "1" ]]; then
        return
    fi
    log "starting x11vnc on :0 -> 5900"
    local x11vnc_args=(-display :99 -forever -shared -rfbport 5900 -bg -o /tmp/x11vnc.log)
    if [[ -n "${VNC_PASSWORD:-}" ]]; then
        local pwfile=/tmp/.vnc-pw
        x11vnc -storepasswd "${VNC_PASSWORD}" "${pwfile}" >/dev/null 2>&1
        x11vnc_args+=(-rfbauth "${pwfile}")
    else
        x11vnc_args+=(-nopw)
    fi
    x11vnc "${x11vnc_args[@]}"

    log "starting websockify (noVNC) on 6080 -> 5900"
    websockify --web=/usr/share/novnc 6080 localhost:5900 &
}

start_mitm() {
    if [[ "${ENABLE_MITM:-0}" != "1" ]]; then
        return
    fi
    log "starting mitmdump on 8080 with capture addon"
    mkdir -p /data/captures/queue /data/captures/dead-letter
    mitmdump \
        -s /app/mitm/addon.py \
        --set "ssl_insecure=true" \
        --set "block_global=false" \
        --listen-port 8080 \
        > /tmp/mitm.log 2>&1 &

    log "starting capture pusher daemon"
    python3 /app/mitm/pusher.py &
}

start_xvfb
start_vnc
start_mitm

log "starting application: $*"
exec "$@"
