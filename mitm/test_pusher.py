"""Pytest coverage for the durable capture pusher.

Tests run without mitmproxy installed; we exercise the queue logic with
hand-rolled JSON files in tmp_path and a stubbed `requests.Session` that
returns the response shape we want.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from unittest.mock import Mock

import pytest


def _import_pusher(monkeypatch: pytest.MonkeyPatch, queue: Path, dead: Path, url: str = "https://api.example.com/captures"):
    monkeypatch.setenv("MITM_QUEUE_DIR", str(queue))
    monkeypatch.setenv("MITM_DEAD_LETTER_DIR", str(dead))
    monkeypatch.setenv("MITM_PUSH_URL", url)
    monkeypatch.setenv("MITM_PUSH_TOKEN", "secret")

    sys.path.insert(0, str(Path(__file__).parent))
    if "pusher" in sys.modules:
        del sys.modules["pusher"]
    import pusher

    return pusher


def _write_capture(queue: Path, name: str = "abc.json") -> Path:
    queue.mkdir(parents=True, exist_ok=True)
    path = queue / name
    path.write_text(json.dumps({"session_id": "demo", "url": "https://example.org/"}))
    return path


def _ok_session(status: int = 200, body: str = '{}') -> Mock:
    response = Mock()
    response.status_code = status
    response.text = body
    response.json.return_value = json.loads(body) if body else {}
    session = Mock()
    session.post.return_value = response
    return session


def test_2xx_unlinks_the_file(tmp_path, monkeypatch):
    queue = tmp_path / "queue"
    dead = tmp_path / "dead"
    pusher = _import_pusher(monkeypatch, queue, dead)
    capture = _write_capture(queue)

    counters = pusher._drain_queue(session=_ok_session(200))

    assert counters == {"ok": 1, "retry": 0, "dead": 0}
    assert not capture.exists()


def test_4xx_moves_to_dead_letter(tmp_path, monkeypatch):
    queue = tmp_path / "queue"
    dead = tmp_path / "dead"
    pusher = _import_pusher(monkeypatch, queue, dead)
    capture = _write_capture(queue, name="bad.json")

    counters = pusher._drain_queue(session=_ok_session(403, body='{"message":"no"}'))

    assert counters == {"ok": 0, "retry": 0, "dead": 1}
    assert not capture.exists()
    assert (dead / "bad.json").exists()


def test_5xx_keeps_file_for_retry(tmp_path, monkeypatch):
    queue = tmp_path / "queue"
    dead = tmp_path / "dead"
    pusher = _import_pusher(monkeypatch, queue, dead)
    capture = _write_capture(queue, name="retry.json")

    counters = pusher._drain_queue(session=_ok_session(503))

    assert counters == {"ok": 0, "retry": 1, "dead": 0}
    assert capture.exists()


def test_network_error_keeps_file(tmp_path, monkeypatch):
    queue = tmp_path / "queue"
    dead = tmp_path / "dead"
    pusher = _import_pusher(monkeypatch, queue, dead)
    capture = _write_capture(queue, name="netfail.json")

    import requests as real_requests

    failing = Mock()
    failing.post.side_effect = real_requests.ConnectionError("boom")

    counters = pusher._drain_queue(session=failing)

    assert counters == {"ok": 0, "retry": 1, "dead": 0}
    assert capture.exists()


def test_unreadable_file_dead_letters(tmp_path, monkeypatch):
    queue = tmp_path / "queue"
    dead = tmp_path / "dead"
    pusher = _import_pusher(monkeypatch, queue, dead)
    queue.mkdir(parents=True, exist_ok=True)
    bad = queue / "broken.json"
    bad.write_text("not json")

    counters = pusher._drain_queue(session=_ok_session(200))

    assert counters == {"ok": 0, "retry": 0, "dead": 1}
    assert not bad.exists()
    assert (dead / "broken.json").exists()


def test_per_flow_bearer_overrides_env_token(tmp_path, monkeypatch):
    queue = tmp_path / "queue"
    dead = tmp_path / "dead"
    pusher = _import_pusher(monkeypatch, queue, dead)
    queue.mkdir(parents=True, exist_ok=True)

    capture = queue / "pool.json"
    capture.write_text(
        json.dumps(
            {
                "session_id": "pool-session-id",
                "request": {"url": "https://example.org/"},
                "_meta": {"bearer": "kdz-mitm-pool-bearer"},
            },
        ),
    )

    session = _ok_session(200)
    pusher._drain_queue(session=session)

    args, kwargs = session.post.call_args
    headers = kwargs["headers"]
    sent_payload = kwargs["json"]

    assert headers["Authorization"] == "Bearer kdz-mitm-pool-bearer"
    assert "_meta" not in sent_payload


def test_env_bearer_used_when_no_meta(tmp_path, monkeypatch):
    queue = tmp_path / "queue"
    dead = tmp_path / "dead"
    pusher = _import_pusher(monkeypatch, queue, dead)
    capture = _write_capture(queue, name="legacy.json")
    assert capture.exists()

    session = _ok_session(200)
    pusher._drain_queue(session=session)

    args, kwargs = session.post.call_args
    assert kwargs["headers"]["Authorization"] == "Bearer secret"
