# patchright-scraper

Single Docker image that powers the kodizm-scrapper-api scraping platform. Two runtime modes from the same image:

- **Pool mode** (default): headless Patchright + Fastify HTTP API. One container per pool slot, short-lived scrape calls.
- **Automation mode** (`ENABLE_XVFB=1` etc.): adds Xvfb, x11vnc, websockify (noVNC), and optional transparent mitmproxy on top of the same Node service. Per-session container with a live browser stream.

Built for `linux/amd64`; CI publishes `anilcancakir/patchright-scraper:vX.Y.Z` and `:latest` to Docker Hub on every `v*.*.*` git tag.

## Endpoints

| Method | Path                                | Purpose                                                      |
| ------ | ----------------------------------- | ------------------------------------------------------------ |
| GET    | `/v1/health`                        | liveness probe                                               |
| POST   | `/v1/scrape`                        | one-shot scrape, fresh ephemeral context                     |
| POST   | `/v1/sessions`                      | create a persistent session (optional `identity_hash`)       |
| GET    | `/v1/sessions`                      | list active sessions                                         |
| DELETE | `/v1/sessions/:id`                  | close a session and free resources                           |
| POST   | `/v1/sessions/:id/scrape`           | scrape inside an existing session                            |
| POST   | `/v1/sessions/:id/navigate`         | navigate the session's page                                  |
| POST   | `/v1/sessions/:id/step`             | execute a registered scenario step                           |
| POST   | `/v1/sessions/:id/screenshot`       | capture a screenshot                                         |
| GET    | `/v1/sessions/:id/state`            | current state (`active` / `idle` / `login_detected` / ...)   |

The `/step` endpoint dispatches to a registry of step executors. The set ships with the image; new primitives drop into `src/steps/`.

## Modes at a glance

```
Pool mode (default)
  docker run -p 8080:8080 anilcancakir/patchright-scraper:latest

Session mode (no display, but persistent profile)
  docker run -p 8080:8080 -v profiles:/data/profiles \
    -e PROFILE_DIR=/data/profiles \
    anilcancakir/patchright-scraper:latest

Automation mode (Xvfb + VNC + mitm)
  docker run -p 8080:8080 -p 6080:6080 \
    -e ENABLE_XVFB=1 -e ENABLE_VNC=1 -e ENABLE_MITM=1 \
    -e MITM_PUSH_URL=https://api.example.com/api/internal/captures \
    -e MITM_PUSH_TOKEN=secret \
    -e MITM_SESSION_ID=$SESSION_ID \
    -v captures:/data/captures \
    anilcancakir/patchright-scraper:latest
```

## Environment reference

### Mode flags

| Variable        | Default | Effect                                                                |
| --------------- | ------- | --------------------------------------------------------------------- |
| `ENABLE_XVFB`   | `0`     | Start Xvfb on `:99`, export `DISPLAY=:99`. Required for VNC and mitm. |
| `ENABLE_VNC`    | `0`     | Start `x11vnc` (port 5900) and `websockify` + noVNC (port 6080).      |
| `VNC_PASSWORD`  | unset   | Optional x11vnc password. LAN-only deployments may leave it unset.    |
| `ENABLE_MITM`   | `0`     | Start `mitmdump` on port 8080 with the capture addon and pusher.      |

### Browser launch

| Variable                  | Default     | Effect                                                                  |
| ------------------------- | ----------- | ----------------------------------------------------------------------- |
| `USER_AGENT`              | unset       | Override `navigator.userAgent`.                                         |
| `LOCALE`                  | `en-US`     | Browser locale.                                                         |
| `TIMEZONE`                | `UTC`       | IANA timezone string.                                                   |
| `VIEWPORT`                | `1920x1080` | Format `WxH`.                                                           |
| `HEADLESS`                | `auto`      | `auto` honours `DISPLAY`. `0` forces headed, `1` forces headless.       |
| `EXTRA_LAUNCH_ARGS_JSON`  | unset       | JSON array of extra Chromium CLI flags appended to launch.              |

### Proxy

| Variable | Default | Format                                                                     |
| -------- | ------- | -------------------------------------------------------------------------- |
| `PROXY`  | unset   | `host:port` or `host:port:user:pass`. Passed straight to Patchright proxy. |

### Stealth + fingerprinting

| Variable                    | Default     | Effect                                                                       |
| --------------------------- | ----------- | ---------------------------------------------------------------------------- |
| `PATCHRIGHT_STEALTH_LEVEL`  | `basic`     | `basic` or `aggressive`.                                                     |
| `FINGERPRINT_PROFILE`       | unset       | Built-in: `desktop`, `mobile-tr`, `googlebot`. Sets UA + locale + headers.   |
| `FINGERPRINT_PROFILE_FILE`  | unset       | Path to a JSON profile, overrides the built-in.                              |
| `JS_INJECTIONS_DIR`         | `/data/inject` | Every `*.js` in this dir gets `addInitScript`-injected on each page boot. |

### Persistence + capture

| Variable           | Default            | Effect                                                            |
| ------------------ | ------------------ | ----------------------------------------------------------------- |
| `PROFILE_DIR`      | unset              | When set + writable, sessions use `${PROFILE_DIR}/${identity_hash}` as the persistent context root. |
| `MITM_PUSH_URL`    | unset              | Where the pusher daemon POSTs each capture.                       |
| `MITM_PUSH_TOKEN`  | unset              | Bearer token for `MITM_PUSH_URL`.                                 |
| `MITM_SESSION_ID`  | unset              | Identifier injected into every capture payload.                   |

## Custom step plugins

Drop a TypeScript file under `src/steps/` that exports a `StepExecutor`:

```ts
import { z } from 'zod';
import type { StepExecutor } from './types.js';

export const myStep: StepExecutor = {
  name: 'my_step',
  schema: z.object({ selector: z.string() }),
  async execute(ctx, config) {
    // ctx.page, ctx.session, ctx.log
    return { ok: true };
  },
};

export default myStep;
```

The registry auto-loads everything under `src/steps/`. Rebuild + tag a new image to ship the new primitive.

## Build and release

Local build (LAN dev):

```bash
bash build.sh                                 # docker build
KODIZM_DOCKER_HOST=root@192.168.68.155 \
  bash build.sh                               # docker build + ssh load
```

Public release: push a `vX.Y.Z` tag. CI builds and pushes `anilcancakir/patchright-scraper:vX.Y.Z` + `:latest` to Docker Hub.

```bash
git tag v0.2.0
git push origin v0.2.0
```

The `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` GitHub secrets must be set before the first tag push.

## Volume mounts

| Host path                 | Container path        | Purpose                                  |
| ------------------------- | --------------------- | ---------------------------------------- |
| `./profiles`              | `/data/profiles`      | Persistent browser contexts per identity |
| `./captures`              | `/data/captures`      | mitm capture queue + dead-letter         |
| `./inject`                | `/data/inject`        | Per-page JS init scripts                 |
| `./fingerprints`          | `/data/fingerprints`  | Custom fingerprint profile JSON files    |

## License

MIT. See `LICENSE`.
