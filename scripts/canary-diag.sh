#!/usr/bin/env bash
# TEMPORARY diagnostic, removed before merge: does plain http:// to a hostname
# work on the published image and on the candidate (ERR_BLOCKED_BY_CLIENT)?
set -uo pipefail

for IMAGE in "$@"; do
    C="patchright-diag-$$"
    echo "######## ${IMAGE}"
    docker run -d --name "$C" --shm-size=1g -e ENABLE_XVFB=1 -p 127.0.0.1::8190 "$IMAGE" >/dev/null
    mapped="$(docker port "$C" 8190/tcp | head -n 1)"
    base="http://127.0.0.1:${mapped##*:}"
    for _ in $(seq 1 45); do curl -sf --max-time 3 "$base/v1/health" >/dev/null && break; sleep 2; done
    echo "== chrome: $(docker exec "$C" google-chrome --version) | patchright: $(docker exec "$C" node -p "require('/app/node_modules/patchright/package.json').version")"
    sid="$(curl -sS -H 'Content-Type: application/json' -d '{}' "$base/v1/sessions" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["session"]["id"])')"
    for url in "http://neverssl.com/" "http://example.com/" "http://httpforever.com/" "https://example.com/" "http://127.0.0.1:9/"; do
        out="$(curl -sS --max-time 60 -H 'Content-Type: application/json' \
            -d "{\"type\":\"goto\",\"config\":{\"url\":\"${url}\",\"timeout\":15000}}" \
            "$base/v1/sessions/$sid/step")"
        echo "== goto ${url} -> ${out:0:260}"
    done
    docker rm -f "$C" >/dev/null 2>&1 || true
done
exit 0
