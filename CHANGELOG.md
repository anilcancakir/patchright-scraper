# Changelog

## Unreleased

## v0.6.10 (2026-09-06)

Shut Chrome down instead of walking away from it, so a profile stops
telling the next launch it crashed.

Chromium writes `profile.exit_type` = "Crashed" at startup and flips it
to "Normal" only during a clean shutdown (`kSessionExitType`,
chrome/common/pref_names.h). The SIGTERM handler closed the Fastify
server and called `process.exit(0)`, so every live context was left to
be killed with the container and nothing ever flipped the marker. The
next container to mount that profile opened on the "Restore pages?"
bubble.

That bubble is not cosmetic. It renders over the top right of the page,
which is where X puts its own controls, and it is one more thing a
recipe's locator can resolve against on a site that already renders
every form twice. On a dedicated account the profile is the identity
and therefore always the same profile, so this happened on every stop,
and it was visible in the live view of the signed-in account.

Two halves, because they cover different lives. `closeAllSessions()`
closes every context on SIGTERM, bounded to six seconds against
`containerStop`'s ten-second grace: a context that will not close was
going to be killed anyway and must not spend the budget of the ones
behind it. `clearCrashMarker()` normalizes the pref before launch, for
the lives no handler can reach, an OOM kill, a `docker kill`, a host
reboot. Same reasoning as the singleton guards, which stay: a fresh
container is a fresh PID namespace, so anything found there belongs to
a life that has already ended.

## v0.6.7 (2026-09-04)

Declare the language through the browser process environment, because
Playwright's `locale` never reaches a Web Worker.

`locale` is delivered by `Emulation.setUserAgentOverride` with an
`acceptLanguage` on the page's own CDP session. Both the command and
the session are per-target, and patchright's worker-attach handler
(`crPage.js:664-699`) wires up execution contexts, network and console
for a worker but never sends the override to it. So the main thread
read `fr-FR` while a `Worker` read `en-US,en`: a combination no real
browser produces, and enough on its own for
deviceandbrowserinfo.com/are_you_a_bot to answer `isBot: true` while
all 21 of its other signals stayed clean. The identity work that closed
one signal had opened a louder one.

Chrome derives `navigator.language`, `navigator.languages` and the
outgoing `Accept-Language` from its application locale, which on Linux
comes from `LANG`/`LC_*`. One native value, read by every execution
context, with no wrapped getter for a prototype-chain detector to
catch. Every session already launches its own browser process, so this
stays per-session.

Verified live across fr, tr and de: main thread and worker report an
identical `fr-FR,fr,en-US,en`, and the wire carries
`Accept-Language: fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7`. That list is
also the shape a real chrome produces, where `locale` yielded a
single-entry `["fr-FR"]` with no fallback.

Seeding `intl.accept_languages` into the profile Preferences was tried
first and does not work: chrome recomputes that pref from the
application locale at startup and overwrote it back on the next launch.

No API change. The sidecar still accepts `locale` on session create and
`LOCALE` on the container; only what it does with the value changed.

## v0.6.6 (2026-09-04)

Start Xvfb with `-noreset`, or the work area v0.6.4 added never
survives to be read.

X resets when its last client connection closes, and a reset frees
every resource including root window properties. The entrypoint's
`xprop` is the only client at that moment, so the `_NET_WORKAREA` it
sets dies with its own connection, before chrome ever connects.

The failure is silent in the worst way: `xprop` exits 0, the entrypoint
logs "work area 1920x1040 of 1920x1080", and the property is already
gone. Caught on the live v0.6.5 pool container, which logged exactly
that and then answered `_NET_WORKAREA: not found`, while the identical
command run by hand persisted because chrome was holding a connection.

## v0.6.5 (2026-09-04)

Clear the previous life's X lock before starting Xvfb.

`/tmp` is the container's writable layer rather than a volume, so
`/tmp/.X99-lock` survives a stop/start. An unclean stop therefore left
a lock no process owned, Xvfb refused the display with "Server is
already active for display 99", the entrypoint's readiness loop exited
1, and `restart: unless-stopped` looped that forever.

The window opened in v0.6.3, which turned `ENABLE_XVFB` on for pool
mode. Before that the pool container never started an X server and had
no lock to leave behind. Hit in production on 2026-09-04: the pool
container crash-looped ten times and the Complex tier was down until
the file was removed by hand.

The removal is unconditional. A container start means a fresh PID
namespace, so nothing from the previous life can still hold the
display and any lock found here is stale by definition. Same reasoning
as `clearSingletonGuards()` for Chrome's profile locks, against the
same class of failure.

## v0.6.4 (2026-09-04)

Give the browser a work area and the keyboard a cadence on the two
paths that still had neither.

`composeThread` was the last text-entry step committing through
`keyboard.insertText`, which routes to Chromium's `ImeCommitText` and
emits no key events at all. A threading account therefore published its
text with no inter-key timing whatever, on a network that names typing
cadence as collected telemetry. It now types character by character
with the same log-normal sampler `type` uses, behind a new `delay`
option defaulting to the 240 ms literature mean; `delay: 0` is an
explicit opt-out that restores the old commit.

`delay` is deliberately NOT budgeted against `timeout` the way `type`
budgets it. Here `timeout` has only ever bounded locator resolution, and
giving it a second meaning would refuse every stored thread recipe on
sight: the live one carries `timeout: 20000` and one 280-character part
at the default needs about 67,000 ms. The job timeout is the backstop.

The container now declares `_NET_WORKAREA` on the root window after
Xvfb comes up, reserving 40 px of height (`WORKAREA_PANEL_PX`). With no
window manager nothing sets that property, and Chromium then leaves the
work area at the full display bounds, so a page read
`screen.availHeight === screen.height`: true on a bare X server and
almost nowhere else. No window manager is installed to fix it, because
Chromium's reader gates only on the property being 4 cardinals of
format 32. Measured on the live pool container: 1080 before, 1040
after. Width is left alone, because a taskbar or a top bar does not
narrow it and `availWidth === width` is the ordinary desktop reading.

## v0.6.1 (2026-08-28)

Clear Chrome's single-instance guards before opening a persistent
profile.

`SingletonLock`, `SingletonCookie` and `SingletonSocket` name the
process that last held the profile. When that process is killed rather
than shut down — the container stopped, an OOM, a host reboot — the
files survive, and the next Chrome to open the profile tries to hand off
to an instance that is gone and waits forever.

The symptom is the worst kind. `POST /v1/sessions` never answers at all,
so the caller sees a client-side timeout that names nothing, while
`/v1/health` keeps returning 200 and the container reads healthy. Found
after recycling a long-lived dedicated container: every fresh container
that mounted that profile hung, on the previous image and the new one
alike, which is what ruled the image out.

Nothing in this system shuts Chrome down politely, so this is what makes
the container stop path survivable at all. Safe unconditionally: Chrome
recreates all three on launch, and cookies, Local State and the profile
directories are untouched.

## v0.6.0 (2026-08-28)

**`composeThread`**: type each part of a multi-part composer, clicking
the add control between parts. Does not submit; the recipe still owns
the click that publishes.

A thread cannot be expressed as a static step list, because the number
of parts is an input and the scenario engine has no loop. It also cannot
be faked with `try_branch`: that catches one exception type and cannot
tell "there is no part 4" from "the add button broke", so a five-part
thread would quietly post as two and report success. The entire reason
to compose a thread in one pass rather than as a reply chain is that it
is all-or-nothing, and swallowing a real failure gives that away.

The ordering is measured rather than assumed. On X the add control is
only present while the last part has content: it disappears the moment a
new empty part is created and returns once that part is typed into. So
each iteration types first and adds second, never two adds running. An
implementation that got this backwards would work for two parts and hang
on three.

`editorTemplate` keeps the site's naming in the recipe, where it can be
repaired without a release, while the loop lives in the step, where it
has to. `{index}` is substituted per part.

## v0.5.1 (2026-08-26)

A locator chain now says WHICH problem each candidate had. "Matched
nothing" means the selector is wrong; "matched 20 elements; add nth to
pick one" means it is right and the recipe has to choose. Those need
opposite fixes and used to share one sentence, which cost a live
debugging session on an X timeline, where one testid legitimately covers
every article on the page.

## v0.5.0 (2026-08-26)

Locator fallback chains, an IME-style text step, and a collector for
virtualized lists.

**`locator` now accepts a chain.** Every step that targets an element
takes either one candidate (unchanged) or an ordered list of them; the
schema normalises both to a list so one shape reaches the resolver.
Resolution polls `count()` across all candidates under ONE shared
budget rather than attempting each in turn, which would have multiplied
the step timeout by the chain length. A candidate matching several
elements without an `nth` is rejected rather than accepted, because
strict mode would throw on the action anyway and taking it would skip a
working fallback first. Every locator-bearing step now reports
`locatorIndex` in its output, so a caller can tell that its preferred
selector has rotted and it is running on a fallback.

**New step `insertText`.** Commits text through CDP `Input.insertText`,
the way an IME does. Rich contentEditable editors built on `beforeinput`
(Draft.js, Lexical, ProseMirror) ignore `fill()` entirely, and
per-character typing races the editor's own mount so the first
characters vanish. When given a locator it CLICKS it first, because
those editors key their edit mode off a native click-sourced focus
event and `focus()` alone leaves them inert.

**New step `scrollAndCollect`.** Harvests rows on every scroll pass and
merges them by a key attribute. On a virtualized list rows unmount as
they leave the viewport, so scroll-then-`extractDom` returns the last
screenful and silently loses everything above it. Stops on consecutive
passes that add nothing, not on a scroll-height plateau, because a
virtualized container keeps its height roughly constant by design.

**Hardened during review.** The budget handed back to an action now
carries a 1s floor: Playwright reads `timeout: 0` as "no timeout" rather
than "fail now", so a candidate matching on the final sweep would have
left the click that followed waiting forever. And a candidate that
THROWS (`count()` raises mid-navigation, and an unrecognised ARIA role
raises too) no longer takes the rest of the chain with it, which was
precisely the case a fallback exists for.

**Fixed: `waitForSelector` ignored its own chain.** It resolved with the
single-sweep resolver, so when the element had not rendered yet, which is
the entire reason the step exists, nothing matched, it fell back to
candidate 0 and waited on that alone. Every fallback was dead and
`locatorIndex` was pinned at 0. It now polls for the two states that mean
"appear" and keeps the single sweep for the two that mean "go away",
which are satisfied by nothing matching.

**Fixed: `type` with `clear: true` called `fill('')`**, which is exactly
the call a contentEditable ignores. The old text stayed and the new text
appended to it. Now select-all + Backspace.

**Fixed: `x-kodizm-session` was sent on every request unconditionally.**
It exists so the mitm addon can attribute a flow to a session; with
capture off nothing reads it and every request to the target carried a
stable non-standard header naming us, which is a cross-request
correlator handed over for free. Now gated on the new `captureTraffic`
session flag, which defaults to false.

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
