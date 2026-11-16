#!/usr/bin/env bash
#
# Chrome canary for a patchright-scraper image. Exit 0 means the image can be
# promoted to :latest; any other exit means it must not be.
#
# It starts the image the way the pool runs it (headed Chrome on Xvfb) and has
# Chrome load a page served over plain http://. Chrome never upgrades http://
# to https:// for localhost, private IPs or non-default ports (playwright issue
# #43871), so the fixture is served on host port 80 under the public-suffix
# name canary.example.com (an --add-host alias, it never resolves elsewhere).
# A Chrome with HttpsUpgrades active then tries TLS against it; the fixture is
# a plain node HTTP listener, so that ClientHello is a clientError it prints as
# CLIENT_ERROR, and the canary fails on that line (from Chrome 156 a failed
# upgrade falls back to http, so the page alone would not prove anything).
# The Chrome version is printed so the workflow can log what it tested.
#
# Usage: scripts/canary.sh <image-ref>

set -euo pipefail

readonly MARKER="kodizm-canary-ok"
readonly SERVICE_PORT=8190
readonly FIXTURE_HOST="canary.example.com"
readonly FIXTURE_ATTEMPTS=30
readonly HEALTH_ATTEMPTS=45
FIXTURE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/canary-fixture"
readonly FIXTURE_DIR

# Runs inside the image under test (--entrypoint node), so the fixture needs no
# host runtime. The clientError handler is what makes a TLS attempt observable.
readonly FIXTURE_SERVER='
const http = require("http");
const fs = require("fs");
const server = http.createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(fs.readFileSync("/fixture/index.html"));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.on("clientError", (err, socket) => {
  console.log("CLIENT_ERROR " + err.code);
  socket.destroy();
});
server.listen(8080, "0.0.0.0");
'

log() {
    echo "[canary] $*"
}

usage() {
    echo "usage: ${0##*/} <image-ref>" >&2
    exit 2
}

[[ $# -eq 1 && -n "$1" ]] || usage

readonly IMAGE="$1"
readonly CONTAINER="patchright-canary-$$"
readonly FIXTURE_CONTAINER="patchright-canary-fixture-$$"

cleanup() {
    local status=$?
    local name

    for name in "${CONTAINER}" "${FIXTURE_CONTAINER}"; do
        if (( status != 0 )) && docker inspect "${name}" >/dev/null 2>&1; then
            log "FAILED (exit ${status}); last output of ${name}:"
            docker logs --tail 40 "${name}" 2>&1 || true
        fi
        docker rm -f "${name}" >/dev/null 2>&1 || true
    done
}
trap cleanup EXIT

# Read one dotted path from a JSON document on stdin.
json_get() {
    python3 -I -c '
import json, sys
node = json.load(sys.stdin)
for key in sys.argv[1].split("."):
    node = node[key]
print(node)
' "$1"
}

# POST a JSON body and print the response. On an HTTP error the body goes to
# stderr, because inside a command substitution a bare curl failure would hide
# the service's own error message.
post_json() {
    local body_file status
    body_file="$(mktemp)"
    status="$(curl -sS --max-time 120 -o "${body_file}" -w '%{http_code}' \
        -H 'Content-Type: application/json' -d "$2" "$1")"
    if [[ "${status}" != 2* ]]; then
        echo "[canary] POST $1 answered HTTP ${status}: $(cat "${body_file}")" >&2
        rm -f "${body_file}"
        return 1
    fi
    cat "${body_file}"
    rm -f "${body_file}"
}

# Host port 80 is privileged; the Docker daemon binds it, so no sudo is needed.
start_fixture() {
    log "starting fixture server on host port 80"
    if ! docker run -d --name "${FIXTURE_CONTAINER}" \
        --entrypoint node \
        -v "${FIXTURE_DIR}:/fixture:ro" \
        -p 80:8080 \
        "${IMAGE}" -e "${FIXTURE_SERVER}" >/dev/null; then
        log "could not start the fixture container (is host port 80 already in use?)"
        exit 1
    fi

    for _ in $(seq 1 "${FIXTURE_ATTEMPTS}"); do
        if curl -sf --max-time 2 "http://127.0.0.1:80/" >/dev/null; then
            return
        fi
        sleep 0.5
    done
    log "fixture server never answered on http://127.0.0.1:80/ (port 80 unavailable or server crashed)"
    exit 1
}

start_container() {
    log "starting ${IMAGE}"
    docker run -d --name "${CONTAINER}" \
        --add-host "${FIXTURE_HOST}:host-gateway" \
        --shm-size=1g \
        -e ENABLE_XVFB=1 \
        -p "127.0.0.1::${SERVICE_PORT}" \
        "${IMAGE}" >/dev/null
}

wait_for_health() {
    local base="$1"
    for _ in $(seq 1 "${HEALTH_ATTEMPTS}"); do
        if curl -sf --max-time 3 "${base}/v1/health" >/dev/null; then
            return
        fi
        sleep 2
    done
    log "/v1/health never answered"
    exit 1
}

main() {
    # 1. Serve the fixture first so the scraper container can reach it as soon as it is up.
    start_fixture
    log "fixture served on host port 80"

    # 2. Start the image and wait until the service answers.
    start_container
    local mapped base
    mapped="$(docker port "${CONTAINER}" "${SERVICE_PORT}/tcp" | head -n 1)"
    base="http://127.0.0.1:${mapped##*:}"
    wait_for_health "${base}"
    log "service healthy at ${base}"

    # 3. Open a session, then navigate to the http:// fixture under its public name.
    local session_id url goto_response final_url
    session_id="$(post_json "${base}/v1/sessions" '{}' | json_get session.id)"
    log "session ${session_id}"

    url="http://${FIXTURE_HOST}/"
    goto_response="$(post_json "${base}/v1/sessions/${session_id}/step" \
        "{\"type\":\"goto\",\"config\":{\"url\":\"${url}\",\"timeout\":30000}}")"
    final_url="$(json_get result.output.url <<<"${goto_response}")"
    if [[ "${final_url}" != "${url}" ]]; then
        log "navigation ended on ${final_url}, expected ${url} (https upgrade?)"
        exit 1
    fi

    # 4. A TLS attempt against the plain HTTP listener is a clientError even when
    #    Chrome falls back to http afterwards and the page still renders.
    #    Captured first: under pipefail, `grep -q` closing the pipe early would
    #    turn a match into a SIGPIPE status and hide the failure.
    local fixture_log
    fixture_log="$(docker logs "${FIXTURE_CONTAINER}" 2>&1)"
    if grep -q '^CLIENT_ERROR' <<<"${fixture_log}"; then
        log "Chrome attempted TLS against the http:// fixture (HttpsUpgrades?)"
        exit 1
    fi

    # 5. Assert the rendered page text, not just the navigation result.
    local text_response page_text
    text_response="$(post_json "${base}/v1/sessions/${session_id}/step" \
        '{"type":"evaluate","config":{"expression":"() => document.body.innerText"}}')"
    page_text="$(json_get result.output.result <<<"${text_response}")"
    if [[ "${page_text}" != *"${MARKER}"* ]]; then
        log "page text '${page_text}' does not contain '${MARKER}'"
        exit 1
    fi
    log "page text asserted"

    # 6. Report the Chrome that was tested.
    docker exec "${CONTAINER}" google-chrome --version
    log "PASS"
}

main
