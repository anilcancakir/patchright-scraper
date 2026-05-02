"""mitmproxy addon: serialise every response to a per-capture JSON file.

Designed for at-most-once-but-eventually delivery. The pusher daemon
polls the queue dir, ships each file to MITM_PUSH_URL, and unlinks on
success. We keep the addon's job tiny: read the response off the wire,
write the file atomically (`.tmp` + rename), return.

`flow.response` carries the response side; `flow.request` is the side
we redact lightly (no auth headers, no cookies). The Laravel side keeps
the heavier capture filter logic; this addon is just the conduit.

Pool mode (v0.4.0): each chrome session stamps an `X-Kodizm-Session`
header on every outbound request via `setExtraHTTPHeaders`. The addon
reads the header and looks up the matching bearer in the registry the
Patchright server writes to `/data/session-bearers.json`. The pusher
later picks up the per-flow bearer and uses it for the per-session
ingest endpoint. When the registry is missing or empty the pusher
falls back to the global `MITM_PUSH_TOKEN` env (legacy single-session
behaviour).
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
SESSION_BEARERS_PATH = os.environ.get("SESSION_BEARERS_PATH", "/data/session-bearers.json")
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


def _read_bearer_registry() -> dict[str, str]:
    """Pool-mode session-id -> bearer map written by the Patchright server.

    Atomic-rename writes on the Node side mean we either see the old
    registry or the new one, never a half-flushed JSON. A missing file
    is fine: the pusher falls back to the global env bearer.
    """
    try:
        with open(SESSION_BEARERS_PATH, "r", encoding="utf-8") as handle:
            decoded = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return {}

    if not isinstance(decoded, dict):
        return {}

    return {str(k): str(v) for k, v in decoded.items()}


def _resolve_session_id(flow: http.HTTPFlow) -> str | None:
    """Pull the session id chrome stamped on the request."""
    for name, value in flow.request.headers.items():
        if name.lower() == SESSION_HEADER_NAME:
            return value
    return None


def _resolve_bearer(session_id: str | None) -> str | None:
    """Look the per-session bearer up in the registry."""
    if session_id is None or session_id == "":
        return None

    registry = _read_bearer_registry()

    return registry.get(session_id)


def _response_payload(flow: http.HTTPFlow) -> dict:
    response = flow.response
    body_b64 = ""
    if response is not None and response.raw_content is not None:
        body_b64 = base64.b64encode(response.raw_content).decode("ascii")

    session_id = _resolve_session_id(flow) or SESSION_ID
    bearer = _resolve_bearer(session_id)

    payload = {
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

    if bearer is not None:
        # The pusher reads `_meta.bearer` and prefers it over the env
        # MITM_PUSH_TOKEN; meta keys are intentionally underscore-prefixed
        # so an upstream reader cannot confuse them with capture data.
        payload["_meta"] = {"bearer": bearer}

    return payload


def response(flow: http.HTTPFlow) -> None:
    """mitmproxy hook fired once a response has been received.

    Skip flows that have no `X-Kodizm-Session` header. Chrome itself
    fires several internal requests during boot (Component Updater
    pinging gvt1.com, Safe Browsing list refresh, telemetry pings)
    that sail past the persistent context's setExtraHTTPHeaders
    layer. Without a session id we cannot resolve a bearer, so the
    pusher dead-letters every capture with a `Missing or malformed
    bearer` 401. None of those flows belong to the operator's run
    anyway, so dropping them keeps the queue clean.
    """
    session_id = _resolve_session_id(flow)

    if session_id is None or session_id == "":
        return

    _ensure_queue_dir()
    payload = _response_payload(flow)

    capture_id = uuid.uuid4().hex
    final_path = os.path.join(QUEUE_DIR, f"{capture_id}.json")
    tmp_path = f"{final_path}.tmp"

    with open(tmp_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, separators=(",", ":"))

    # Atomic rename so the pusher never reads a half-written file.
    os.rename(tmp_path, final_path)
