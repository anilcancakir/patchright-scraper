# Changelog

## Unreleased

## v0.2.2 (2026-04-27)

Live noVNC viewer fix. The previous x11vnc invocation deadlocked under
busy Xvfb scenes: the TCP socket accepted the websockify connection but
the RFB greeting was never written back, leaving every noVNC client
hanging on "Connecting...". Reproduced reliably with the upstream
kodizm-scrapper-api `live-vnc-viewer` plan once the iframe + URL layers
were ruled out.

- `entrypoint.sh` now invokes x11vnc with `-threads` so the accept loop
  runs in its own pthread and is no longer blocked by the framebuffer
  reader.
- `-rfbportv6 -1` silences the "address already in use" warning when the
  IPv4 listener wins the race against the IPv6 bind.
- Log line now reflects the real display (`:99 -> 5900`).

## v0.2.1 (2026-04-27)

Step API hardening + discovery. Closes the audit-followups Phase 2
backlog so the upcoming PHP `AutomationClient` can introspect the
contract instead of guessing parameter names.

- Every step's zod schema is now `.strict()`. Unknown keys (the audit's
  `scroll_by({dx, dy})` typo case) now reject with a `ZodError` instead
  of silently falling through to defaults.
- `GET /v1/steps` returns rich descriptors per step: `{ name,
  description, schema }`, where `schema` is the JSON Schema
  serialization of the step's zod schema. Old name-only consumers see
  this as a breaking shape change.
- New `STEPS.md` reference doc covers all 22 primitives in one place.
- `StepExecutor` interface gains an optional `description` field.
- Bumps `package.json` to `0.2.1`.

## v0.2.0 (2026-04-26)

Automation runtime + scenario step API + durable capture pipeline. From
this release on, a single image powers both the pool engine and the
per-session browser automation flow.

Added:

- `ENABLE_XVFB`, `ENABLE_VNC`, `ENABLE_MITM` env flags. The image now
  installs xvfb, x11vnc, websockify, noVNC, mitmproxy 11 unconditionally
  and the entrypoint boots them only when requested.
- `tini` as PID 1 for clean signal forwarding.
- Step executor registry (`StepExecutor` interface + zod schema validation)
  and 22 built-in primitives across navigation, input, inspection, scroll
  + viewport categories.
- New endpoints: `POST /v1/sessions/:id/step`, `GET /v1/sessions/:id/state`,
  `POST /v1/sessions/:id/navigate`, `POST /v1/sessions/:id/screenshot`,
  `GET /v1/steps`.
- Session state machine (`active` / `idle` / `login_detected` / `closed` /
  `errored`) with optional `login_signature` regex match per session.
- Persistent profile support via `PROFILE_DIR` + per-session
  `identity_hash` subdir (multiple sessions for the same identity
  share the dir).
- Browser launch customisation env: `USER_AGENT`, `LOCALE`, `TIMEZONE`,
  `VIEWPORT`, `HEADLESS=auto|0|1`, `EXTRA_LAUNCH_ARGS_JSON`.
- Proxy passthrough via `PROXY=host:port[:user:pass]`.
- Stealth knobs: `PATCHRIGHT_STEALTH_LEVEL=basic|aggressive`,
  `FINGERPRINT_PROFILE` (built-in `desktop`, `mobile-tr`, `googlebot`),
  `FINGERPRINT_PROFILE_FILE` for a custom JSON, `JS_INJECTIONS_DIR`
  for per-page init scripts.
- mitmproxy capture pipeline: addon writes every response into
  `/data/captures/queue/<uuid>.json` atomically; `mitm/pusher.py`
  daemon POSTs each one to `MITM_PUSH_URL` with bearer auth, deletes
  on 2xx, dead-letters on 4xx, exponential backoff on 5xx / network.
  Survives container restart because the queue dir is volume-mounted.
- CI: `release.yml` drafts a GitHub release on every `v*.*.*` tag push;
  `release-docker.yml` builds + pushes
  `anilcancakir/patchright-scraper:vX.Y.Z` and `:latest` for `linux/amd64`.

## v0.1.0 (2026-04-26)

Initial extraction from `kodizm-scrapper-api/docker/patchright-scraper/` at the moment the project gained its own home.

Includes:

- Fastify HTTP service for one-shot scraping (`POST /v1/scrape`)
- Short-lived session lifecycle (`POST /v1/sessions`, `POST /v1/sessions/{id}/scrape`, `DELETE /v1/sessions/{id}`)
- Patchright (Playwright stealth fork) backed by `mcr.microsoft.com/playwright:v1.56.0-jammy`
- Multi-stage Dockerfile, single platform (`linux/amd64`)
- Vitest test scaffold

Automation mode (Xvfb / VNC / mitmproxy) and the full step primitive set arrive in v0.2.0.
