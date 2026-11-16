#!/usr/bin/env bash
#
# Chrome canary for a patchright-scraper image. Exit 0 means the image can be
# promoted to :latest; any other exit means it must not be.
#
# It starts the image the way the pool runs it (headed Chrome on Xvfb) and checks
# the things a new Chrome has broken before:
#   1. launch, navigate and read a page: a fixture served by a node process
#      inside the container is opened by IP literal (127.0.0.1:8080). A
#      public-looking name that resolves to a private address is refused by this
#      Chrome (net::ERR_BLOCKED_BY_CLIENT), and an IP literal is never upgraded,
#      so a name cannot be used to observe an upgrade against a local fixture.
#   2. no https upgrade: a plain http:// page on the real internet
#      (neverssl.com exists to stay on http) must still end on http://. Chrome 156
#      started upgrading http:// navigations (playwright issue #43871) and the
#      driver was meant to switch that off. The check fails only on a positive
#      signal (the final URL is https://); an unreachable site is a warning, so a
#      network blip never blocks a promotion.
# The Chrome version is printed so the workflow log shows what was tested.
#
# Usage: scripts/canary.sh <image-ref>

set -euo pipefail

readonly MARKER="kodizm-canary-ok"
readonly SERVICE_PORT=8190
readonly FIXTURE_PORT=8080
readonly FIXTURE_URL="http://127.0.0.1:${FIXTURE_PORT}/"
readonly PLAIN_HTTP_URL="http://neverssl.com/"
readonly HEALTH_ATTEMPTS=45
readonly FIXTURE_ATTEMPTS=20
FIXTURE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/canary-fixture"
readonly FIXTURE_DIR

# Runs inside the container under test (node is in the image), so the fixture
# needs no host runtime and no published port.
readonly FIXTURE_SERVER='
const http = require("http");
const fs = require("fs");
http.createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(fs.readFileSync("/tmp/canary-fixture/index.html"));
    return;
  }
  res.writeHead(404);
  res.end();
}).listen(8080, "127.0.0.1");
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

cleanup() {
    local status=$?

    if (( status != 0 )) && docker inspect "${CONTAINER}" >/dev/null 2>&1; then
        log "FAILED (exit ${status}); last container output:"
        docker logs --tail 40 "${CONTAINER}" 2>&1 || true
    fi
    docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
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

start_container() {
    log "starting ${IMAGE}"
    docker run -d --name "${CONTAINER}" \
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

start_fixture() {
    docker cp "${FIXTURE_DIR}" "${CONTAINER}:/tmp/canary-fixture"
    docker exec -d "${CONTAINER}" node -e "${FIXTURE_SERVER}"

    for _ in $(seq 1 "${FIXTURE_ATTEMPTS}"); do
        if docker exec "${CONTAINER}" node -e \
            "require('http').get('${FIXTURE_URL}', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"; then
            return
        fi
        sleep 0.5
    done
    log "fixture server inside the container never answered on ${FIXTURE_URL}"
    exit 1
}

# Navigate the session and print the URL the page ended on.
goto_final_url() {
    local base="$1" session_id="$2" url="$3" response
    response="$(post_json "${base}/v1/sessions/${session_id}/step" \
        "{\"type\":\"goto\",\"config\":{\"url\":\"${url}\",\"timeout\":30000}}")" || return 1
    json_get result.output.url <<<"${response}"
}

main() {
    # 1. Start the image and wait until the service answers.
    start_container
    local mapped base
    mapped="$(docker port "${CONTAINER}" "${SERVICE_PORT}/tcp" | head -n 1)"
    base="http://127.0.0.1:${mapped##*:}"
    wait_for_health "${base}"
    log "service healthy at ${base}"

    start_fixture
    log "fixture answering inside the container"

    # 2. Open a session and read the fixture page through Chrome.
    local session_id final_url
    session_id="$(post_json "${base}/v1/sessions" '{}' | json_get session.id)"
    log "session ${session_id}"

    final_url="$(goto_final_url "${base}" "${session_id}" "${FIXTURE_URL}")"
    if [[ "${final_url}" != "${FIXTURE_URL}" ]]; then
        log "navigation ended on ${final_url}, expected ${FIXTURE_URL}"
        exit 1
    fi

    local text_response page_text
    text_response="$(post_json "${base}/v1/sessions/${session_id}/step" \
        '{"type":"evaluate","config":{"expression":"() => document.body.innerText"}}')"
    page_text="$(json_get result.output.result <<<"${text_response}")"
    if [[ "${page_text}" != *"${MARKER}"* ]]; then
        log "page text '${page_text}' does not contain '${MARKER}'"
        exit 1
    fi
    log "fixture page asserted"

    # 3. A plain http:// page must stay on http://. Fail only on a positive signal.
    if final_url="$(goto_final_url "${base}" "${session_id}" "${PLAIN_HTTP_URL}")"; then
        if [[ "${final_url}" == https://* ]]; then
            log "${PLAIN_HTTP_URL} ended on ${final_url}: Chrome upgraded an http:// navigation (HttpsUpgrades?)"
            exit 1
        fi
        log "no https upgrade (${PLAIN_HTTP_URL} ended on ${final_url})"
    else
        log "WARNING: ${PLAIN_HTTP_URL} was unreachable, the https upgrade check was skipped"
    fi

    # 4. Report the Chrome that was tested.
    docker exec "${CONTAINER}" google-chrome --version
    log "PASS"
}

main
