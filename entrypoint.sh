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

    # Clear the previous life's X lock before starting, or an unclean
    # stop brings the container down permanently.
    #
    # /tmp is the writable layer, not a volume, so .X99-lock survives a
    # stop/start. Xvfb then refuses with "Server is already active for
    # display 99", the readiness loop below exits 1, and the restart
    # policy loops that forever. Seen in production 2026-09-04: the pool
    # container crash-looped 10 times and the tier was down until the
    # file was removed by hand.
    #
    # Unconditional, because a fresh container start means a fresh PID
    # namespace: nothing from the previous life can still be holding the
    # display, so any lock found here is stale by definition. Same
    # reasoning as clearSingletonGuards() for Chrome's profile locks,
    # and the same failure it exists to prevent.
    rm -f /tmp/.X99-lock /tmp/.X11-unix/X99

    log "starting Xvfb on :99 (${screen})"
    Xvfb :99 -screen 0 "${screen}" -ac +extension RANDR -nolisten tcp &
    export DISPLAY=:99
    # Give Xvfb a moment to actually accept connections; cheap loop avoids
    # racing the browser launch.
    for _ in {1..20}; do
        if xdpyinfo -display :99 >/dev/null 2>&1; then
            declare_work_area
            return
        fi
        sleep 0.1
    done
    log "Xvfb did not become ready"
    exit 1
}

# Reserve a panel-sized strip of the screen, so a page reads
# screen.availHeight < screen.height the way it does on any real desktop.
#
# With no window manager nothing sets _NET_WORKAREA, and chromium then
# leaves the work area at the full display bounds: availHeight ==
# height, which is true on a bare X server and almost nowhere else.
#
# No window manager is installed to fix it, because none is needed.
# Verified at chromium 05ac68951abd29aa0eb16207fbbe5f8d3042c3a9:
# GetWorkAreaSync (ui/base/x/x11_display_util.cc:73-82) gates only on
# "the fetch returned format 32 with exactly 4 values". It checks
# neither _NET_SUPPORTING_WM_CHECK nor _NET_SUPPORTED, and it reads the
# first 4 cardinals rather than indexing by _NET_CURRENT_DESKTOP, so one
# property on the root window is the whole requirement. ClipWorkArea
# (:139-179) then intersects it into the primary display, and
# DisplayUtil::DisplayToScreenInfo (ui/display/display_util.cc:19)
# copies work_area into the available_rect that Screen::availHeight
# reads. Measured on the live pool container 2026-09-04: 1080 before,
# 1040 after.
#
# Height only. A bottom taskbar or a top bar leaves the width alone, so
# availWidth == width is the ordinary case on a real desktop and
# narrowing it would be the rarer reading.
#
# The rect must be strictly smaller than the display or ClipWorkArea's
# "the work area contains the whole display, so leave it alone" branch
# takes it and nothing changes.
declare_work_area() {
    local reserve="${WORKAREA_PANEL_PX:-40}"
    local viewport="${VIEWPORT:-1920x1080}"
    local width="${viewport%%x*}"
    local height="${viewport##*x}"

    if [[ ! "${width}${height}" =~ ^[0-9]+$ ]] || (( height <= reserve )); then
        log "work area left unset: VIEWPORT=${viewport} reserve=${reserve}"
        return
    fi

    # Not fatal. A container without a work area is what every release
    # before this one shipped, and refusing to start over a fingerprint
    # detail would take the tier down for a strictly smaller problem.
    if xprop -root -f _NET_WORKAREA 32c \
        -set _NET_WORKAREA "0, 0, ${width}, $((height - reserve))" 2>/dev/null; then
        log "work area ${width}x$((height - reserve)) of ${viewport}"
    else
        log "WARNING: could not set _NET_WORKAREA; availHeight will equal screen height"
    fi
}

start_vnc() {
    if [[ "${ENABLE_VNC:-0}" != "1" ]]; then
        return
    fi
    log "starting x11vnc on :99 -> 5900"
    # `-threads` is required: without it x11vnc's accept loop runs in the
    # same thread as the framebuffer reader, which deadlocks under busy
    # Xvfb scenes; the TCP socket accepts but the RFB greeting is never
    # written back, so noVNC sits forever on "Connecting...".
    # IPv6 disabled (`-rfbportv6 -1`) to silence the "address already in
    # use" noise that x11vnc prints when the IPv4 listener wins the race.
    local x11vnc_args=(-display :99 -forever -shared -threads -rfbport 5900 -rfbportv6 -1 -bg -o /tmp/x11vnc.log)
    if [[ -n "${VNC_PASSWORD:-}" && -n "${VNC_VIEW_PASSWORD:-}" ]]; then
        # Write a plaintext passwdfile so x11vnc can enforce view-only for
        # clients that authenticate with VNC_VIEW_PASSWORD. The format is:
        #   <control-password>
        #   __BEGIN_VIEWONLY__
        #   <view-only-password>
        # Entries before __BEGIN_VIEWONLY__ get full control; entries after
        # are restricted to view-only by libvncserver's input filter.
        local pwfile=/tmp/.vnc-passwdfile
        printf '%s\n__BEGIN_VIEWONLY__\n%s\n' "${VNC_PASSWORD}" "${VNC_VIEW_PASSWORD}" > "${pwfile}"
        chmod 600 "${pwfile}"
        x11vnc_args+=(-passwdfile "${pwfile}")
    elif [[ -n "${VNC_PASSWORD:-}" ]]; then
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
