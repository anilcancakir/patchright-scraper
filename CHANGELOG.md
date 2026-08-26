# Changelog

## Unreleased

## v0.4.7 (2026-05-31)

x11vnc view-only password support via `-passwdfile`. When both `VNC_PASSWORD`
and `VNC_VIEW_PASSWORD` are set, `start_vnc()` now writes a plaintext
passwdfile at `/tmp/.vnc-passwdfile` (chmod 600) in the format x11vnc expects:

```
<control-password>
__BEGIN_VIEWONLY__
<view-only-password>
```

Clients authenticating with the control password retain full keyboard and
pointer input. Clients authenticating with the view password have input
forwarding blocked at the libvncserver layer (not just the client side).

When only `VNC_PASSWORD` is set the existing `-storepasswd`/`-rfbauth` path
is unchanged. When neither variable is set the existing `-nopw` path is
unchanged. No other sections of the entrypoint are affected.

New environment variable: `VNC_VIEW_PASSWORD` (optional; see README).

## v0.4.6 (2026-05-02)

Capture-optional architecture. The pool's mitm sidecar still ships
on every container, but it only intercepts traffic for sessions the
operator opted in to via `ScraperRunService::dispatch(captureTraffic:
true)`. Capture-off dispatches skip the mitm proxy + cert-trust +
per-flow JSON write entirely, saving roughly 1-2s per scrape.

Two image-side changes back the new wire contract:

- **Patchright `context.route()` injects `X-Kodizm-Session`.** Chrome's
  HTTP/2 stack does not surface `extraHTTPHeaders` reliably to mitm's
  `flow.request.headers.items()` (the header gets folded into the
  SETTINGS frame and never appears on the per-request map). The
  Patchright route interceptor sits above the network stack: every
  Request fires through the hook, we mutate headers, and the
  augmented set lands on every wire frame regardless of HTTP version.
  mitm sees the header, the addon resolves `session_id` off it, and
  pool-mode capture attribution finally works end-to-end.
- **Single pool ingest bearer + payload-only session resolution.**
  The per-session bearer registry the addon used to consult on every
  flow is gone. The container launches with one `MITM_PUSH_TOKEN`
  (the `kdz-pool-{32hex}` bearer the Laravel `PatchrightPoolProvisioner`
  stamps on the launchSpec env + `Container.labels['kdz.pool_bearer_hash']`).
  The addon writes `payload.session_id` from the route-interceptor
  header and ships every capture with that one env-level bearer; the
  upstream `ValidateMitmBearer` middleware hashes the bearer, looks
  up the matching pool Container, then resolves the Session from
  `payload.session_id` (defense in depth: the resolved Session's
  `engine_payload.pool_container_id` MUST match the bearer's
  Container so a leaked bearer cannot pollute another pool's
  captures).

Wire shape stays back-compat: `SessionCreateSchema.bearer` is still
optional in the Fastify request body so older callers keep working;
the field no longer drives anything image-side. Legacy `_meta`
envelopes from in-flight v0.4.5 queue files keep getting stripped by
the pusher.

## v0.4.5 (2026-05-02)

Two unrelated fixes that landed in the same release because they
both bubbled up from the live host smoke matrix.

mitm addon skips chrome-internal flows. Chrome's component updater,
Safe Browsing pings, and telemetry probes fire during launch and
sail past the persistent context's setExtraHTTPHeaders layer, so
they reached the mitm sidecar without an `X-Kodizm-Session` header.
Those captures used to land on the queue with `session_id="unknown"`,
the pusher could not resolve a bearer, and Laravel rejected them
with 401 `invalid_bearer` for every chrome boot. Drop the flow at
the addon when no session header is present so the queue +
dead-letter stay clean.

Disable scraping-irrelevant chrome surfaces. Scraping never needs
the password manager, the "Save password?" bubble, the autofill
prompt, the translate banner, or the optimization-hints ping. Seed
chrome's Preferences JSON before launch (kills the bubbles) and
pass `--disable-features=PasswordLeakDetection,AutofillServerCommunication,SafeBrowsingEnhancedProtection,OptimizationHints,Translate`
on launch (closes the leak / heuristics network surface). Mirrors
the existing helper in poke-api/docker/chrome-worker so the same
UX never flips back on between codebases.

## v0.4.4 (2026-05-02)

Pusher Accept header. `mitm/pusher.py` now sends
`Accept: application/json` on every push so Laravel renders auth +
validation failures as JSON envelopes instead of the default
web-style 302 redirect to `/`. Without the header the pusher
dead-lettered every file on an apparent 302 even when the bearer
and payload were perfectly valid.

## v0.4.3 (2026-05-02)

Launch settle delay. v0.4.2's mutex serialised the launch call but
chrome's zygote / GPU / network-service spawn races still tripped
the next waiter with a "Target page, context or browser has been
closed" error in stress runs. Hold the lock for an extra
`PATCHRIGHT_LAUNCH_SETTLE_MS` (1200ms default) after each
successful launch so the previous chrome's worker processes finish
their handshake before the next chrome boots.

The settle window is env-tunable so operators can profile their own
hardware: faster hosts can drop to 600ms; slower hosts may need
1500-2000ms.

## v0.4.2 (2026-05-02)

Concurrent createSession serialisation. Pool dispatches that fire
multiple createSession requests in parallel were spawning chrome
processes in the same millisecond, racing on the user-data-dir
lock + the connection negotiation, and returning HTTP 500 to
upstream callers in the 10-20% range under stress.

session.ts now routes every `chromium.launchPersistentContext`
call through a single-slot promise queue. Createsession can still
run mid-flow code in parallel (bearer registry, state hooks,
extraHTTPHeaders), but only one chrome boot happens at a time.
Cost: per-request 1-3s queue wait under a burst. Benefit: every
call eventually returns HTTP 200; no more 500s leaking to user
dispatch flows.

The lock is in-process only; horizontal scale (>1 pool container
per host) still gives parallel throughput because each container
runs its own queue.

## v0.4.1 (2026-05-02)

Pool mitm capture pipeline fix. Pool sessions now route chrome
through the in-container mitm sidecar and accept the sidecar's
self-signed CA chain so every TLS request lands on the capture
queue.

Added:

- `SessionCreate.ignoreHTTPSErrors` (optional boolean). When true,
  `chromium.launchPersistentContext` opens the context with cert
  validation off so flows proxied through mitmdump never trip
  `ERR_CERT_AUTHORITY_INVALID`. Off by default to keep direct
  scrape paths strict.

Upstream PHP wiring (`PatchrightPoolProvisioner::mintInContainerSession`)
now sends `proxy: { server: 'http://127.0.0.1:8080' }` plus
`ignoreHTTPSErrors: true` whenever the Session row carries a
mitm bearer.

## v0.4.0 (2026-05-02)

Pool mode foundations. Same image, same `POST /v1/sessions` contract,
new wiring so the upstream Kodizm `PatchrightPoolProvisioner` can run
N sessions inside one container with per-session capture routing.

Added:

- `SessionCreate.bearer` (optional). Sessions land in
  `/data/session-bearers.json` (atomic-rename writes) so the mitm
  sidecar can route per-flow captures with the right ingest token.
- Chrome auto-stamps `X-Kodizm-Session: <id>` on every outbound
  request via `setExtraHTTPHeaders`. The mitm addon reads the
  header, looks the bearer up in the registry, and embeds it as
  `_meta.bearer` on the queued capture file.
- `mitm/pusher.py` honours `_meta.bearer` per-flow (pool mode) and
  falls back to `MITM_PUSH_TOKEN` (legacy single-session) when the
  envelope is absent. `_meta` strips before the upstream POST.
- New endpoints:
    - `POST   /v1/sessions/:id/vnc` touches the VNC stream so the
      shared display stays alive (returns the websockify URL +
      expires_at).
    - `DELETE /v1/sessions/:id/vnc` clears the VNC flag.
    - `GET    /v1/sessions/:id/vnc` reports current state.
- Three-tier idle settings (`CHROME_IDLE_MS`, `VNC_IDLE_MS`).
  Chrome idle defaults to 1h; VNC idle defaults to 15 min. The
  reaper closes context past CHROME_IDLE and clears stale VNC
  flags past VNC_IDLE.
- `hydrateBearerRegistry()` runs on boot so a fresh container
  starts with an empty registry on disk.

Pending in v0.4.1 (per-session VNC display isolation):
- Each session gets its own Xvfb display + websockify port.
  v0.4.0 still ships a shared display; the lifecycle endpoints are
  in place so the upstream PHP wiring can reach for them today.



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
