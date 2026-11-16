#!/usr/bin/env bash
# TEMPORARY diagnostic, removed before merge: which fixture addressing does the
# image's Chrome refuse (ERR_BLOCKED_BY_CLIENT on the host-gateway name)?
set -uo pipefail

IMAGE="$1"
C="patchright-diag-$$"
trap 'docker rm -f "$C" >/dev/null 2>&1 || true' EXIT

SERVER='
const http = require("http");
const net = require("net");
const html = "<!doctype html><p id=marker>kodizm-canary-ok</p>";
for (const port of [80, 8080]) {
  http.createServer((q, r) => { console.log("HTTP " + port + " " + q.url); r.writeHead(200, {"Content-Type": "text/html"}); r.end(html); })
    .on("clientError", (e, s) => { console.log("CLIENT_ERROR " + port + " " + e.code); s.destroy(); })
    .listen(port, "0.0.0.0");
}
net.createServer((s) => { console.log("TLS_ATTEMPT 443"); s.destroy(); }).listen(443, "0.0.0.0");
'

docker run -d --name "$C" \
    --add-host canary-host.example.com:host-gateway \
    --add-host canary-local.example.com:127.0.0.1 \
    --shm-size=1g -e ENABLE_XVFB=1 -p 127.0.0.1::8190 "$IMAGE" >/dev/null
docker exec -d "$C" node -e "$SERVER"
mapped="$(docker port "$C" 8190/tcp | head -n 1)"
base="http://127.0.0.1:${mapped##*:}"
for _ in $(seq 1 45); do curl -sf --max-time 3 "$base/v1/health" >/dev/null && break; sleep 2; done

echo "== id: $(docker exec "$C" id -u), chrome: $(docker exec "$C" google-chrome --version)"
docker exec "$C" sh -c 'cat /etc/hosts; echo; ip -4 route 2>/dev/null || true'
sid="$(curl -sS -H 'Content-Type: application/json' -d '{}' "$base/v1/sessions" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["session"]["id"])')"
echo "== session $sid"

try_goto() {
    local url="$1" out
    out="$(curl -sS --max-time 60 -H 'Content-Type: application/json' \
        -d "{\"type\":\"goto\",\"config\":{\"url\":\"${url}\",\"timeout\":15000}}" \
        "$base/v1/sessions/$sid/step")"
    echo "== goto ${url} -> ${out:0:300}"
}

try_goto "http://127.0.0.1:8080/"
try_goto "http://127.0.0.1/"
try_goto "http://canary-local.example.com/"
try_goto "http://canary-local.example.com:8080/"
try_goto "http://canary-host.example.com/"
try_goto "https://example.com/"
try_goto "data:text/html,<p>hi</p>"
echo "== container node log (fixture hits and TLS attempts)"
docker logs "$C" 2>&1 | grep -E '^(HTTP|CLIENT_ERROR|TLS_ATTEMPT)' || true
exit 0
