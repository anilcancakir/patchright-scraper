import { chromium, type BrowserContext, type Page } from 'patchright';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveLaunchArgs } from './browser/launch-args.js';
import type { SessionCreate } from './types.js';
import type { SessionState } from './steps/types.js';

/**
 * Drop Chrome's single-instance guards before opening a profile.
 *
 * `SingletonLock`, `SingletonCookie` and `SingletonSocket` name the
 * process that last held the profile. When that process was killed
 * rather than shut down (container stopped, OOM, host rebooted), the
 * files survive, and the next Chrome to open the profile tries to hand
 * off to an instance that is gone and waits. The symptom is the worst
 * kind: `POST /v1/sessions` never answers at all, so the caller sees a
 * client-side timeout that names nothing, while /v1/health keeps
 * returning 200 and the container reads healthy.
 *
 * Found on 2026-08-28 after recycling a long-lived dedicated container:
 * every fresh container that mounted that profile hung, on the old
 * image and the new one alike, which is what ruled the image out.
 *
 * Safe to delete unconditionally. Chrome recreates all three on launch,
 * and nothing that constitutes a login lives in them: cookies, Local
 * State and the profile directories are untouched. {@see closeAllSessions}
 * now shuts Chrome down politely on SIGTERM, which clears these the way
 * Chrome intends, but the lives that end in SIGKILL still cannot, so
 * this stays as the floor rather than the only defence.
 */
export function clearSingletonGuards(profilePath: string): void {
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    rmSync(join(profilePath, name), { force: true });
  }
}

/**
 * Seed chrome's user-data-dir Preferences JSON before the persistent
 * context launches.
 *
 * Scraping does not need the password manager, the autofill bubble,
 * the translate banner, or the desktop notification permission
 * prompt. None of these can be turned off via CLI flags reliably;
 * writing the JSON ahead of launch is the only stable kill-switch.
 *
 * Mirrors the helper in poke-api/docker/chrome-worker so the same
 * UX never flips back on between codebases.
 */
/**
 * Turn a BCP-47 tag into the browser process environment that declares
 * it, or undefined when nothing named a language.
 *
 * Playwright's `locale` option is the obvious way to do this and it is
 * the wrong one. It is delivered by `Emulation.setUserAgentOverride`
 * with an `acceptLanguage` on the PAGE's own CDP session, and both that
 * command and the session are per-target: patchright's worker-attach
 * handler (`patchright-core/lib/server/chromium/crPage.js:664-699`)
 * sets up execution contexts, network and console for a worker and
 * never sends the override to it. Measured on the live container: the
 * main thread read `fr-FR` while a `Worker` read `en-US,en`, a
 * combination no real browser produces. It was enough on its own for
 * deviceandbrowserinfo.com to answer `isBot: true` with all 21 of its
 * other signals clean.
 *
 * Chrome instead derives `navigator.language`, `navigator.languages`
 * and the outgoing `Accept-Language` from its application locale, which
 * on Linux comes from `LANG`/`LC_*`. That is one native value every
 * execution context reads, so the two cannot disagree, and there is no
 * wrapped getter for a prototype-chain lie detector to catch.
 *
 * Seeding `intl.accept_languages` into the profile's Preferences was
 * tried first and does not work: chrome recomputes that pref from the
 * application locale at startup and overwrote `fr-FR,fr` back to
 * `en-US,en` on the next launch.
 *
 * Verified live across fr, tr and de. Main thread and worker report an
 * identical `fr-FR,fr,en-US,en`, and the wire carries
 * `Accept-Language: fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7`. That list
 * shape is also what a real chrome produces, where the `locale` option
 * yielded a single-entry `["fr-FR"]` with no fallback.
 *
 * The whole of `process.env` is spread in because Playwright's `env`
 * REPLACES the browser process environment rather than extending it,
 * and dropping `DISPLAY` would leave chrome with no X server.
 */
function localeEnvironment(locale: string | undefined): Record<string, string> | undefined {
  if (locale === undefined || locale === '') {
    return undefined;
  }

  const posix = locale.replace('-', '_');

  return {
    ...(process.env as Record<string, string>),
    LANG: `${posix}.UTF-8`,
    LANGUAGE: posix,
    LC_ALL: `${posix}.UTF-8`,
  };
}

/**
 * Tell the next Chrome that the last one is gone, not crashed.
 *
 * Chromium writes `profile.exit_type` = "Crashed" at startup and flips
 * it to "Normal" only during a clean shutdown (the pref is
 * `kSessionExitType`, documented in chrome/common/pref_names.h as "Set
 * to kPrefExitTypeCrashed on startup and one of kPrefExitTypeNormal or
 * kPrefExitTypeSessionEnded during shutdown"). A life that ended in
 * SIGKILL never gets to flip it, so the next launch opens on the
 * "Restore pages?" bubble.
 *
 * That bubble is not cosmetic here. It renders over the top-right of
 * the page, which is where X puts its own controls, and it is one more
 * thing a recipe's locator can resolve against on a site that already
 * renders every form twice.
 *
 * {@see closeAllSessions} is the half that stops the marker being
 * written in the first place; this is the half that covers the lives no
 * handler can reach, an OOM kill, a `docker kill`, a host reboot. Same
 * reasoning as {@see clearSingletonGuards}: a fresh container is a
 * fresh PID namespace, so anything found here belongs to a life that
 * has already ended.
 */
function clearCrashMarker(prefs: Record<string, unknown>): void {
  const profile = (prefs['profile'] as Record<string, unknown>) ?? {};

  prefs['profile'] = {
    ...profile,
    exit_type: 'Normal',
  };
}

function seedChromePreferences(profilePath: string): void {
  const defaultDir = join(profilePath, 'Default');
  const prefsPath = join(defaultDir, 'Preferences');

  try {
    mkdirSync(defaultDir, { recursive: true });
  } catch {
    return;
  }

  let prefs: Record<string, unknown> = {};

  if (existsSync(prefsPath)) {
    try {
      prefs = JSON.parse(readFileSync(prefsPath, 'utf-8'));
    } catch {
      prefs = {};
    }
  }

  const profile = (prefs['profile'] as Record<string, unknown>) ?? {};
  const profileDefaults = (profile['default_content_setting_values'] as Record<string, unknown>) ?? {};
  const autofill = (prefs['autofill'] as Record<string, unknown>) ?? {};
  const translate = (prefs['translate'] as Record<string, unknown>) ?? {};

  prefs['credentials_enable_service'] = false;
  prefs['credentials_enable_autosignin'] = false;
  prefs['profile'] = {
    ...profile,
    password_manager_enabled: false,
    default_content_setting_values: {
      ...profileDefaults,
      notifications: 2,
    },
  };
  prefs['autofill'] = {
    ...autofill,
    enabled: false,
    credit_card_enabled: false,
    profile_enabled: false,
  };
  prefs['translate'] = {
    ...translate,
    enabled: false,
  };
  clearCrashMarker(prefs);

  try {
    writeFileSync(prefsPath, JSON.stringify(prefs), { encoding: 'utf-8' });
  } catch {
    // Read-only profile dir; the disable-features flag still kicks in
    // for the launch but the password / translate bubbles may flicker.
  }
}

/**
 * Belt-and-braces chrome flags that complement the Preferences seed.
 *
 * `PasswordLeakDetection` removes the password leak surface (no
 * outbound request to the leak service), `AutofillServerCommunication`
 * stops the autofill heuristics ping, `SafeBrowsingEnhancedProtection`
 * silences the post-install onboarding card. The Preferences seed
 * above is what actually kills the bubbles.
 */
const SCRAPING_DISABLE_FEATURES = [
  'PasswordLeakDetection',
  'AutofillServerCommunication',
  'SafeBrowsingEnhancedProtection',
  'OptimizationHints',
  'Translate',
].join(',');

/**
 * Chrome flags for the launch, sized to the resolved viewport.
 *
 * `--test-type` is the one that pays: chromium's
 * `chrome/browser/ui/startup/infobar_utils.cc:221-227` returns on it
 * before reaching `ShowBadFlagsPrompt()`, so the bad-flag warning bar
 * never opens. Measured 2026-09-03 inside the live prod container,
 * reading `outerHeight - innerHeight` off the X window title with no
 * CDP involved: 143 without it, **87** with it, so the bar was taking
 * 56 px out of every page's viewport. The infobar-disabling switch
 * patchright already passes (with its own comment admitting chrome
 * ignores it, having dropped it from the switch table) is deliberately
 * not repeated here: the same run measured 143 with it. That one is
 * pinned by name in tests/session/launch-identity.test.ts.
 *
 * `--window-size` and `--window-position` close the other half of the
 * geometry giveaway. Patchright sets neither, which is why the same run
 * found a 945-wide window sitting at 10,10 on a 1920x1080 screen; both
 * were confirmed settable (`--window-size=1280,900` produced outerWidth
 * 1280, `--window-position=0,0` produced screenX/Y 0,0).
 *
 * `--enable-unsafe-swiftshader` is the difference between having WebGL
 * and not having it. Measured 2026-09-05 in the live pool container:
 * without it, `getContext` returned null for 'webgl', 'webgl2' AND
 * 'experimental-webgl' while `WebGLRenderingContext` still existed as a
 * function, and `chrome://gpu` gave the reason as "GPU process was unable
 * to boot: GPU access is disabled due to frequent crashes. Disabled
 * Features: all". There is no `/dev/dri` in the container and chrome no
 * longer falls back to a software rasteriser for WebGL on its own.
 *
 * A desktop browser with no WebGL context at all is close to unheard of,
 * and every fingerprinting suite x.com loads (Arkose, Castle and Socure
 * are all named in its own CSP) reads the WebGL vendor and renderer.
 * "Absent" is a rarer answer than "software rendered", so this trades one
 * for the other knowingly: the renderer now reads "ANGLE (Google, Vulkan
 * 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)".
 *
 * Three variants were launched in the container to pick this one.
 * `--use-gl=angle --use-angle=swiftshader` produces the identical string,
 * so the shorter flag wins. Routing ANGLE at the Mesa llvmpipe device
 * that `chrome://gpu` advertises as GPU0 does NOT work: `--use-angle=gl`
 * returned null with and without the swiftshader flag. The llvmpipe
 * renderer string, which would have read as an ordinary Linux desktop
 * with no GPU driver, is simply not reachable in this image.
 */
function resolveChromeArgs(viewport: { width: number; height: number }): string[] {
  return [
    // Strip chrome's password manager / autofill / translate /
    // optimization-hints surfaces. Scraping never wants the bubbles,
    // the leak ping, or the heuristics ping; the Preferences seed
    // above silences the bubbles, this flag closes the network
    // surface.
    `--disable-features=${SCRAPING_DISABLE_FEATURES}`,
    '--test-type',
    '--enable-unsafe-swiftshader',
    `--window-size=${viewport.width},${viewport.height}`,
    '--window-position=0,0',
  ];
}

interface ManagedSession {
  id: string;
  context: BrowserContext;
  page: Page;
  profilePath: string;
  createdAt: number;
  lastUsedAt: number;
  state: SessionState;
  loginSignature?: RegExp;
  identityHash?: string;
  bearer?: string;
  vncRequestedAt?: number;
}

const sessions = new Map<string, ManagedSession>();
const PROFILE_ROOT = process.env.PROFILE_ROOT ?? process.env.PROFILE_DIR ?? '/data/profiles';
const SESSION_BEARERS_PATH = process.env.SESSION_BEARERS_PATH ?? '/data/session-bearers.json';
const CHROME_IDLE_MS = Number(process.env.CHROME_IDLE_MS ?? process.env.SESSION_IDLE_MS ?? 60 * 60 * 1000);

/**
 * Does this container carry the Chrome sandbox grant?
 *
 * `--no-sandbox` is not passed by anything in this source; it is
 * playwright's `launchPersistentContext` default
 * (`chromiumSandbox: false`), and it sits in chromium's `kBadFlags[]`.
 * Running chrome under its own sandbox needs the container to have
 * been created with a seccomp profile that allows an unprivileged
 * namespace-creating `clone`, which the provisioner grants together
 * with this env key, in the same launch spec.
 *
 * Reading the key rather than asking unconditionally is the backward
 * compatibility guarantee: the provisioner only invalidates a stopped
 * container on an image-digest change, so every container created
 * before the grant existed keeps its old HostConfig, and a sandboxed
 * chrome would simply fail to start inside it. Compared against '1'
 * exactly, because env values are strings and '0' is truthy here.
 */
const CHROME_SANDBOX_GRANTED = process.env.CHROME_SANDBOX === '1';
const VNC_IDLE_MS = Number(process.env.VNC_IDLE_MS ?? 15 * 60 * 1000);

/**
 * Concurrency gate for `chromium.launchPersistentContext` calls.
 *
 * Pool mode lets N sessions share one container, so a single dispatch
 * batch routinely fires multiple createSession requests in parallel.
 * Patchright (and Playwright underneath) starts a fresh chrome process
 * per persistent context; spawning 5+ chrome processes in the same
 * millisecond races on the user-data-dir lock + the chrome connection
 * negotiation, returning HTTP 500s to upstream callers.
 *
 * Serialise the launch step through a single-slot promise queue:
 * createSession can still run mid-flow code in parallel (cookies +
 * bearer registry + state hooks), but only one chrome boot happens
 * at a time. After every successful launch we hold the lock for an
 * extra `LAUNCH_SETTLE_MS` so chrome's zygote + GPU + network
 * service processes finish their handshake before the next waiter
 * spawns its own chrome and they stop tripping each other's
 * "Target ... has been closed" race.
 */
const LAUNCH_SETTLE_MS = Number(process.env.PATCHRIGHT_LAUNCH_SETTLE_MS ?? 1200);

let launchQueue: Promise<unknown> = Promise.resolve();

function withLaunchLock<T>(callback: () => Promise<T>): Promise<T> {
  const next = launchQueue.then(async () => {
    const result = await callback();
    if (LAUNCH_SETTLE_MS > 0) {
      await new Promise((resolve) => setTimeout(resolve, LAUNCH_SETTLE_MS));
    }
    return result;
  });

  // Swallow the result type so the queue chain stays unknown-typed and
  // a single failed launch never blocks subsequent waiters from running.
  launchQueue = next.catch(() => undefined);

  return next;
}

export interface CreateSessionInput extends SessionCreate {
  loginSignature?: string;
  identityHash?: string;
  bearer?: string;
}

/**
 * Atomically rewrite the session-bearers registry the mitm sidecar
 * reads. The addon picks the right token per intercepted request by
 * matching the chrome-stamped `X-Kodizm-Session` header against this
 * map; without atomic write the addon could read a half-flushed JSON
 * mid-update.
 */
function persistBearerRegistry(): void {
  const map: Record<string, string> = {};

  for (const session of sessions.values()) {
    if (session.bearer !== undefined && session.bearer !== '') {
      map[session.id] = session.bearer;
    }
  }

  const tmp = `${SESSION_BEARERS_PATH}.tmp`;

  try {
    writeFileSync(tmp, JSON.stringify(map), { encoding: 'utf-8' });
    renameSync(tmp, SESSION_BEARERS_PATH);
  } catch (error) {
    // Sidecar may not be enabled in this image; the file just stays
    // out of date, the addon falls back to MITM_PUSH_TOKEN env.
    console.warn('[session] bearer registry write failed:', (error as Error).message);
  }
}

/**
 * Open (or look up) a long-lived persistent context. The page handle
 * lives on the session so step executors share it across calls. The
 * optional bearer lands in the bearer registry the mitm sidecar reads
 * for per-session capture routing.
 */
export async function createSession(input: CreateSessionInput): Promise<ManagedSession> {
  const id = input.sessionId ?? randomUUID();

  const existing = sessions.get(id);
  if (existing !== undefined) {
    existing.lastUsedAt = Date.now();
    if (input.bearer !== undefined && input.bearer !== '') {
      existing.bearer = input.bearer;
      persistBearerRegistry();
    }

    return existing;
  }

  const subdir = input.identityHash ?? id;
  const profilePath = join(PROFILE_ROOT, subdir);
  mkdirSync(profilePath, { recursive: true });
  clearSingletonGuards(profilePath);
  seedChromePreferences(profilePath);

  // Only stamped when something is listening for it. The header exists
  // so the mitm addon can attribute a flow to a session; with capture
  // off nothing reads it and every request to the target would carry a
  // stable non-standard header naming us, which is a cross-request
  // correlator we would be handing over for free.
  const extraHeaders: Record<string, string> = input.captureTraffic
    ? { 'X-Kodizm-Session': id }
    : {};

  // The container's own identity, as the provisioner set it. Four
  // fields are consumed and the rest deliberately ignored: the
  // resolver's `EXTRA_LAUNCH_ARGS_JSON` list would open an
  // operator-settable arbitrary chrome flag channel, which is a
  // fingerprint and security surface nothing here needs, and
  // `headless` / `proxy` are already decided per session.
  const containerIdentity = resolveLaunchArgs();

  // Per-session first, container env second, on every field. Get the
  // order backwards and a caller that names a zone to match its exit
  // address is silently overruled by the box it happens to run on.
  const resolvedViewport = input.viewport ?? containerIdentity.viewport;

  // The resolver floors `locale` at 'en-US', and that floor must not
  // reach chrome: an unset session locale passes nothing today, and
  // forcing a locale where none was asked for is a behaviour change
  // beyond this wiring. So the env has to actually say something.
  const containerLocale = process.env.LOCALE ? containerIdentity.locale : undefined;
  const launchEnv = localeEnvironment(input.locale ?? containerLocale);

  const context = await withLaunchLock(() =>
    chromium.launchPersistentContext(profilePath, {
      channel: 'chrome',
      headless: process.env.DISPLAY ? false : true,
      proxy: input.proxy,
      userAgent: input.userAgent ?? containerIdentity.userAgent,
      // `locale` is deliberately NOT passed. See localeEnvironment().
      ...(launchEnv === undefined ? {} : { env: launchEnv }),
      // The whole point of the wiring: a browser leaving from a proxy
      // in Istanbul used to declare the host clock, because nothing
      // read the TIMEZONE the provisioner hands every container.
      timezoneId: input.timezoneId ?? containerIdentity.timezoneId,
      // Emulate a viewport only when the session asks for one. A
      // patchright viewport is CDP metrics emulation, and for a headful
      // persistent context patchright also resizes the window to the
      // viewport plus hardcoded Linux insets (8 x 131, patchright-core
      // crPage.js:836-849). `VIEWPORT` doubles as the Xvfb screen
      // geometry (entrypoint.sh:18), so emulating the container default
      // would ask for a 1928x1211 window on a 1920x1080 screen and make
      // `outerHeight - innerHeight` read 131, throwing away the 87 the
      // --window-size path measures. The container default reaches
      // chrome as --window-size instead.
      viewport: input.viewport ?? null,
      extraHTTPHeaders: extraHeaders,
      // Pool mode routes chrome through the in-container mitm sidecar
      // so every TLS request lands on the capture queue. mitmproxy
      // signs intercepted responses with its own CA, so the browser
      // must accept the cert chain when the caller flags it.
      ignoreHTTPSErrors: input.ignoreHTTPSErrors ?? false,
      args: resolveChromeArgs(resolvedViewport),
      // Spread rather than `chromiumSandbox: CHROME_SANDBOX_GRANTED`:
      // an ungranted container must leave the option unset so
      // playwright's own default stays in charge, exactly as it is for
      // every container running today.
      ...(CHROME_SANDBOX_GRANTED ? { chromiumSandbox: true } : {}),
    }),
  );

  // Belt-and-braces session-id stamping. extraHTTPHeaders does not
  // surface reliably on chrome HTTP/2 requests (the header gets
  // packed into the SETTINGS frame and never appears on mitm's
  // flow.request.headers.items()). The playwright route interceptor
  // sits above the network stack: every Request fires through this
  // hook, we mutate headers, and the augmented set lands on every
  // wire frame regardless of HTTP version. mitm sees the header,
  // the addon resolves session_id off it, and the capture pipeline
  // attributes flows correctly even in pool mode where N sessions
  // share one container.
  if (input.captureTraffic) {
    await context.route('**/*', async (route) => {
      const headers = {
        ...route.request().headers(),
        'x-kodizm-session': id,
      };

      await route.continue({ headers });
    });
  }

  const page = context.pages()[0] ?? (await context.newPage());

  const session: ManagedSession = {
    id,
    context,
    page,
    profilePath,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    state: 'active',
    loginSignature: input.loginSignature ? new RegExp(input.loginSignature) : undefined,
    identityHash: input.identityHash,
    bearer: input.bearer,
  };

  sessions.set(id, session);

  if (input.bearer !== undefined && input.bearer !== '') {
    persistBearerRegistry();
  }

  return session;
}

export function getSession(id: string): ManagedSession | undefined {
  const session = sessions.get(id);
  if (session !== undefined) {
    session.lastUsedAt = Date.now();
  }

  return session;
}

export async function destroySession(id: string): Promise<boolean> {
  const session = sessions.get(id);
  if (session === undefined) {
    return false;
  }

  session.state = 'closed';

  try {
    await session.context.close();
  } finally {
    sessions.delete(id);
    if (session.bearer !== undefined) {
      persistBearerRegistry();
    }
  }

  return true;
}

/**
 * Close every live context before the process goes away.
 *
 * This is what lets Chrome shut down rather than be killed, and a
 * Chrome that shuts down writes `profile.exit_type` = "Normal" into the
 * profile. Without it the next container to mount that profile opens on
 * the "Restore pages?" bubble, and on a dedicated account the profile
 * IS the identity, so it is the same profile every time.
 *
 * The budget is the point. `containerStop` grants ten seconds before
 * SIGKILL, so a context that will not close must not be allowed to
 * spend them: waiting past the grace buys nothing (the kill lands
 * anyway, the marker stays) and costs the sessions that would have
 * closed cleanly behind it. Whatever finishes inside the budget is
 * saved; whatever does not was going to be killed regardless.
 *
 * Resolves to the number of contexts that closed in time.
 */
export async function closeAllSessions(budgetMs: number): Promise<number> {
  const live = [...sessions.entries()];

  if (live.length === 0) {
    return 0;
  }

  let closed = 0;

  const closes = live.map(async ([id, session]) => {
    session.state = 'closed';

    try {
      await session.context.close();
      closed += 1;
    } catch {
      // A context already detached is already as closed as it gets.
    } finally {
      sessions.delete(id);
    }
  });

  await Promise.race([
    Promise.allSettled(closes),
    new Promise((resolve) => setTimeout(resolve, budgetMs)),
  ]);

  return closed;
}

export function listSessions(): Array<{
  id: string;
  createdAt: number;
  lastUsedAt: number;
  state: SessionState;
  vncActive: boolean;
}> {
  const cutoff = Date.now() - VNC_IDLE_MS;

  return Array.from(sessions.values()).map((s) => ({
    id: s.id,
    createdAt: s.createdAt,
    lastUsedAt: s.lastUsedAt,
    state: s.state,
    vncActive: s.vncRequestedAt !== undefined && s.vncRequestedAt > cutoff,
  }));
}

/**
 * Mark the session's VNC stream as freshly requested. Pool mode runs
 * chrome headless by default, so the operator's noVNC iframe call
 * stamps `vncRequestedAt`; the watchdog leaves the shared Xvfb stack
 * up while at least one session has stamped within the last
 * `VNC_IDLE_MS` window.
 */
export function touchVnc(session: ManagedSession): void {
  session.vncRequestedAt = Date.now();
  session.lastUsedAt = Date.now();
}

/**
 * Flag the session's VNC stream as inactive immediately. Pool mode
 * cannot kill the shared display while another session still holds
 * an iframe; the watchdog reconciles based on every session's flag.
 */
export function clearVnc(session: ManagedSession): void {
  session.vncRequestedAt = undefined;
}

/**
 * Compare the page's current url against the session's login signature
 * and flip the state when it matches. Called after every step / navigate.
 */
export function refreshState(session: ManagedSession): SessionState {
  if (session.state === 'closed' || session.state === 'errored') {
    return session.state;
  }

  if (session.loginSignature !== undefined) {
    const url = session.page.url();
    if (session.loginSignature.test(url)) {
      session.state = 'login_detected';
      return session.state;
    }
  }

  session.state = 'active';
  return session.state;
}

/**
 * Periodic reaper: closes sessions idle longer than CHROME_IDLE_MS
 * and clears stale VNC flags past VNC_IDLE_MS. Started from server.ts
 * and shut down on SIGTERM.
 */
export function startIdleReaper(): NodeJS.Timeout {
  return setInterval(async () => {
    const now = Date.now();
    const chromeCutoff = now - CHROME_IDLE_MS;
    const vncCutoff = now - VNC_IDLE_MS;

    let bearerDirty = false;

    for (const [id, session] of sessions.entries()) {
      if (session.vncRequestedAt !== undefined && session.vncRequestedAt < vncCutoff) {
        session.vncRequestedAt = undefined;
      }

      if (session.lastUsedAt > chromeCutoff) {
        continue;
      }

      session.state = 'idle';

      try {
        await session.context.close();
      } catch {
        // ignore: context may already be detached
      }

      sessions.delete(id);

      if (session.bearer !== undefined) {
        bearerDirty = true;
      }
    }

    if (bearerDirty) {
      persistBearerRegistry();
    }
  }, 30_000);
}

/**
 * Boot-time hydration: rewrite the bearer registry to match the live
 * session map (empty after a fresh boot, populated when sessions are
 * recreated post-restart).
 */
export function hydrateBearerRegistry(): void {
  persistBearerRegistry();
}

/**
 * Read the on-disk bearer registry. The mitm sidecar uses this to
 * attach a per-session bearer to outbound capture pushes; tests reach
 * for it to assert the registry stays in sync.
 */
export function readBearerRegistry(): Record<string, string> {
  try {
    const raw = readFileSync(SESSION_BEARERS_PATH, { encoding: 'utf-8' });
    const decoded = JSON.parse(raw);

    if (typeof decoded === 'object' && decoded !== null) {
      return decoded as Record<string, string>;
    }
  } catch {
    // Missing file is fine; sidecar falls back to env.
  }

  return {};
}

export type { ManagedSession };
