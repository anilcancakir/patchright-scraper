"""Durable capture pusher.

Watches `/data/captures/queue/` for `*.json` files written by the
mitmproxy addon, POSTs each one to `MITM_PUSH_URL`, deletes on a 2xx,
moves to `dead-letter/` on a 4xx (caller-side failure), and leaves the
file in place with exponential backoff on 5xx / network errors. Files
survive container restarts because the queue dir is mounted from the
host.

Run as a long-lived daemon, started from entrypoint.sh.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import time
from pathlib import Path
from typing import Optional

import requests

QUEUE_DIR = Path(os.environ.get("MITM_QUEUE_DIR", "/data/captures/queue"))
DEAD_LETTER_DIR = Path(os.environ.get("MITM_DEAD_LETTER_DIR", "/data/captures/dead-letter"))
PUSH_URL = os.environ.get("MITM_PUSH_URL")
PUSH_TOKEN = os.environ.get("MITM_PUSH_TOKEN")
POLL_INTERVAL = float(os.environ.get("MITM_PUSHER_POLL_SECONDS", "1.0"))
INITIAL_BACKOFF = float(os.environ.get("MITM_PUSHER_BACKOFF_SECONDS", "1.0"))
MAX_BACKOFF = float(os.environ.get("MITM_PUSHER_MAX_BACKOFF_SECONDS", "60.0"))
HTTP_TIMEOUT = float(os.environ.get("MITM_PUSHER_TIMEOUT_SECONDS", "10.0"))

logging.basicConfig(level=logging.INFO, format="[pusher] %(message)s")
log = logging.getLogger("mitm.pusher")


def _headers() -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if PUSH_TOKEN:
        headers["Authorization"] = f"Bearer {PUSH_TOKEN}"
    return headers


def _push_one(path: Path, session: Optional[requests.Session] = None) -> str:
    """Push a single capture file. Returns the action taken: ok, retry, dead."""
    if PUSH_URL is None or PUSH_URL == "":
        log.warning("MITM_PUSH_URL is unset; leaving %s in queue", path.name)
        return "retry"

    try:
        with path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        log.error("unreadable capture %s: %s, moving to dead-letter", path.name, exc)
        DEAD_LETTER_DIR.mkdir(parents=True, exist_ok=True)
        shutil.move(str(path), str(DEAD_LETTER_DIR / path.name))
        return "dead"

    http = session or requests
    try:
        response = http.post(PUSH_URL, json=payload, headers=_headers(), timeout=HTTP_TIMEOUT)
    except requests.RequestException as exc:
        log.warning("network error pushing %s: %s", path.name, exc)
        return "retry"

    if 200 <= response.status_code < 300:
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        return "ok"

    if 400 <= response.status_code < 500:
        log.error(
            "permanent failure pushing %s: %s %s, dead-lettering",
            path.name,
            response.status_code,
            response.text[:200],
        )
        DEAD_LETTER_DIR.mkdir(parents=True, exist_ok=True)
        shutil.move(str(path), str(DEAD_LETTER_DIR / path.name))
        return "dead"

    log.warning("transient failure pushing %s: %s, will retry", path.name, response.status_code)
    return "retry"


def _drain_queue(session: Optional[requests.Session] = None) -> dict[str, int]:
    """Walk the queue once. Returns counters: ok, retry, dead."""
    counters = {"ok": 0, "retry": 0, "dead": 0}
    if not QUEUE_DIR.exists():
        return counters

    files = sorted(p for p in QUEUE_DIR.iterdir() if p.is_file() and p.suffix == ".json")
    for path in files:
        outcome = _push_one(path, session=session)
        counters[outcome] += 1
    return counters


def main() -> None:
    log.info("starting; queue=%s push_url=%s", QUEUE_DIR, PUSH_URL or "<unset>")
    QUEUE_DIR.mkdir(parents=True, exist_ok=True)
    DEAD_LETTER_DIR.mkdir(parents=True, exist_ok=True)

    backoff = INITIAL_BACKOFF
    session = requests.Session()

    while True:
        counters = _drain_queue(session=session)

        if counters["retry"] == 0:
            backoff = INITIAL_BACKOFF
            time.sleep(POLL_INTERVAL)
            continue

        log.info("retry queue=%s, sleeping %.1fs", counters["retry"], backoff)
        time.sleep(backoff)
        backoff = min(MAX_BACKOFF, backoff * 2)


if __name__ == "__main__":
    main()
