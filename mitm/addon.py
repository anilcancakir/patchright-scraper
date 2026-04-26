"""mitmproxy addon: serialise every response to a per-capture JSON file.

Designed for at-most-once-but-eventually delivery. The pusher daemon
polls the queue dir, ships each file to MITM_PUSH_URL, and unlinks on
success. We keep the addon's job tiny: read the response off the wire,
write the file atomically (`.tmp` + rename), return.

`flow.response` carries the response side; `flow.request` is the side
we redact lightly (no auth headers, no cookies). The Laravel side keeps
the heavier capture filter logic; this addon is just the conduit.
"""

import base64
import json
import os
import time
import uuid
from typing import Iterable

from mitmproxy import http

QUEUE_DIR = os.environ.get("MITM_QUEUE_DIR", "/data/captures/queue")
SESSION_ID = os.environ.get("MITM_SESSION_ID", "unknown")

# Headers we silently strip on the request side. Captures are not the
# place to leak the operator's bearer or the target site's cookie jar.
REDACT_REQUEST_HEADERS = {
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
}


def _ensure_queue_dir() -> None:
    os.makedirs(QUEUE_DIR, exist_ok=True)


def _redacted_request_headers(headers: Iterable[tuple[str, str]]) -> dict[str, str]:
    out: dict[str, str] = {}
    for name, value in headers:
        if name.lower() in REDACT_REQUEST_HEADERS:
            out[name] = "<redacted>"
        else:
            out[name] = value
    return out


def _response_payload(flow: http.HTTPFlow) -> dict:
    response = flow.response
    body_b64 = ""
    if response is not None and response.raw_content is not None:
        body_b64 = base64.b64encode(response.raw_content).decode("ascii")

    return {
        "session_id": SESSION_ID,
        "request": {
            "url": flow.request.pretty_url,
            "method": flow.request.method,
            "headers": _redacted_request_headers(flow.request.headers.items()),
            "host": flow.request.host,
            "scheme": flow.request.scheme,
        },
        "response": {
            "status": response.status_code if response is not None else 0,
            "headers": dict(response.headers.items()) if response is not None else {},
            "body_b64": body_b64,
        },
        "timestamp_ms": int(time.time() * 1000),
    }


def response(flow: http.HTTPFlow) -> None:
    """mitmproxy hook fired once a response has been received."""
    _ensure_queue_dir()
    payload = _response_payload(flow)

    capture_id = uuid.uuid4().hex
    final_path = os.path.join(QUEUE_DIR, f"{capture_id}.json")
    tmp_path = f"{final_path}.tmp"

    with open(tmp_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, separators=(",", ":"))

    # Atomic rename so the pusher never reads a half-written file.
    os.rename(tmp_path, final_path)
