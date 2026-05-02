"""mitmproxy addon: serialise every response to a per-capture JSON file.

Designed for at-most-once-but-eventually delivery. The pusher daemon
polls the queue dir, ships each file to MITM_PUSH_URL, and unlinks on
success. We keep the addon's job tiny: read the response off the wire,
write the file atomically (`.tmp` + rename), return.

`flow.response` carries the response side; `flow.request` is the side
we redact lightly (no auth headers, no cookies). The Laravel side keeps
the heavier capture filter logic; this addon is just the conduit.

Pool mode (v0.4.6): every chrome session stamps `X-Kodizm-Session: <id>`
on outbound requests through a Patchright `context.route()` interceptor
(see `session.ts`). The route hook sits above chrome's network stack so
the header lands on every HTTP/2 frame; the addon reads `flow.request
.headers` and surfaces the value as `payload.session_id`. Authentication
to the upstream Laravel ingest endpoint is now driven by a single
`MITM_PUSH_TOKEN` env (the pool ingest bearer the launchSpec injects)
rather than a per-session bearer registry; the bearer registry read is
gone entirely. Flows with no `X-Kodizm-Session` header are dropped at
the addon (chrome-internal Component Updater, Safe Browsing, telemetry
pings) so the queue + dead-letter stay clean.
"""

import base64
import json
import os
import time
import uuid
from typing import Iterable

from mitmproxy import http

QUEUE_DIR = os.environ.get("MITM_QUEUE_DIR", "/data/captures/queue")
SESSION_HEADER_NAME = "x-kodizm-session"

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


def _resolve_session_id(flow: http.HTTPFlow) -> str | None:
    """Pull the session id chrome stamped on the request via the
    Patchright route interceptor. Returns None when the header is
    absent (chrome-internal flows that bypass both setExtraHTTPHeaders
    and route())."""
    for name, value in flow.request.headers.items():
        if name.lower() == SESSION_HEADER_NAME:
            return value
    return None


def _response_payload(flow: http.HTTPFlow, session_id: str) -> dict:
    response = flow.response
    body_b64 = ""
    if response is not None and response.raw_content is not None:
        body_b64 = base64.b64encode(response.raw_content).decode("ascii")

    return {
        "session_id": session_id,
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
    """mitmproxy hook fired once a response has been received.

    Skip flows that have no `X-Kodizm-Session` header. Chrome itself
    fires several internal requests during boot (Component Updater
    pinging gvt1.com, Safe Browsing list refresh, telemetry pings)
    that bypass the Patchright route interceptor. None of those flows
    belong to the operator's run, and the upstream ValidateMitmBearer
    middleware would reject them with 401 invalid_bearer because no
    Session can be resolved. Dropping at the addon keeps the queue
    + dead-letter clean.
    """
    session_id = _resolve_session_id(flow)

    if session_id is None or session_id == "":
        return

    _ensure_queue_dir()
    payload = _response_payload(flow, session_id)

    capture_id = uuid.uuid4().hex
    final_path = os.path.join(QUEUE_DIR, f"{capture_id}.json")
    tmp_path = f"{final_path}.tmp"

    with open(tmp_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, separators=(",", ":"))

    # Atomic rename so the pusher never reads a half-written file.
    os.rename(tmp_path, final_path)
