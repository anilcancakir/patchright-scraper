import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionCreateSchema } from '../../src/types.js';
import { makePage } from '../steps/_helpers.js';

/**
 * The launch identity is decided before chrome starts, so these tests
 * assert on the options object handed to `launchPersistentContext`
 * rather than launching anything: a real persistent context needs a
 * display, and CI has none. The live proof is a separate step.
 */
const { launchPersistentContext } = vi.hoisted(() => ({
  launchPersistentContext: vi.fn(),
}));

vi.mock('patchright', () => ({
  chromium: { launchPersistentContext },
}));

interface LaunchOptions {
  timezoneId?: string;
  locale?: string;
  userAgent?: string;
  viewport?: { width: number; height: number } | null;
  args: string[];
  env?: Record<string, string>;
}

const MANAGED_ENV = [
  'TIMEZONE',
  'LOCALE',
  'VIEWPORT',
  'USER_AGENT',
  'DISPLAY',
  'PROFILE_ROOT',
  'PROFILE_DIR',
  'PATCHRIGHT_LAUNCH_SETTLE_MS',
] as const;

let savedEnv: Record<string, string | undefined> = {};

/**
 * A BrowserContext stand-in with only what `createSession` touches.
 * `tests/steps/_helpers.ts` covers the page surface; the context
 * surface a launch needs (pages / newPage / close) is local because a
 * step never sees it.
 */
function makeBrowserContext(): Record<string, unknown> {
  const page = makePage();

  return {
    pages: () => [page],
    newPage: async () => page,
    route: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

/**
 * Re-import the module per launch: `PROFILE_ROOT` and the live session
 * map are module-level, so a stale import would answer from the
 * previous test's cache instead of launching again.
 */
async function launchWith(input: Record<string, unknown> = {}): Promise<LaunchOptions> {
  vi.resetModules();
  const { createSession } = await import('../../src/session.js');
  await createSession({ captureTraffic: false, ...input } as never);

  const call = launchPersistentContext.mock.calls.at(-1);
  expect(call, 'launchPersistentContext was never called').toBeDefined();

  return call?.[1] as LaunchOptions;
}

beforeEach(() => {
  savedEnv = {};
  for (const key of MANAGED_ENV) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }

  process.env.PROFILE_ROOT = mkdtempSync(join(tmpdir(), 'kdz-launch-identity-'));
  // The 1.2 s post-launch settle exists so real chrome processes stop
  // racing on the user-data-dir; no chrome boots here.
  process.env.PATCHRIGHT_LAUNCH_SETTLE_MS = '0';

  launchPersistentContext.mockReset();
  launchPersistentContext.mockImplementation(async () => makeBrowserContext());
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }
});

describe('launch identity precedence', () => {
  it('lets the per-session timezoneId win over the container TIMEZONE', async () => {
    process.env.TIMEZONE = 'Europe/Istanbul';

    const options = await launchWith({ timezoneId: 'America/New_York' });

    expect(options.timezoneId).toBe('America/New_York');
  });

  it('takes the container TIMEZONE when the session names no zone', async () => {
    // The dedicated provisioner hands every Complex container a
    // TIMEZONE; before this wiring nothing read it, so a proxy in
    // Istanbul left from a browser declaring the host clock.
    process.env.TIMEZONE = 'Europe/Istanbul';

    const options = await launchWith();

    expect(options.timezoneId).toBe('Europe/Istanbul');
  });

  it('declares UTC when neither the session nor the container names a zone', async () => {
    const options = await launchWith();

    expect(options.timezoneId).toBe('UTC');
  });

  it('never passes locale to the context, because that value never reaches a worker', async () => {
    // Measured on the live container 2026-09-04. Playwright's `locale`
    // is delivered by `Emulation.setUserAgentOverride({acceptLanguage})`
    // on the PAGE's own CDP session, and patchright's worker-attach
    // handler (crPage.js:664-699) never sends it to the worker session,
    // so the main thread read fr-FR while a Worker read en-US,en. That
    // is a combination no real browser produces, and one public
    // detector flips its whole verdict on it while all 21 of its other
    // signals stay clean.
    process.env.LOCALE = 'fr-FR';

    expect((await launchWith({ locale: 'tr-TR' })).locale).toBeUndefined();
    expect((await launchWith()).locale).toBeUndefined();
  });

  it('declares the language through the browser process environment instead', async () => {
    // Chrome derives navigator.language, navigator.languages AND the
    // Accept-Language header from its application locale, which on
    // Linux comes from LANG/LC_*. That is one native value read by
    // every execution context, so the main thread and a Worker cannot
    // disagree. Verified live across fr, tr and de: identical in both
    // contexts, with Accept-Language on the wire reading
    // `fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7`.
    process.env.LOCALE = 'fr-FR';

    const perSession = await launchWith({ locale: 'tr-TR' });

    expect(perSession.env?.LANG).toBe('tr_TR.UTF-8');
    expect(perSession.env?.LANGUAGE).toBe('tr_TR');
    expect(perSession.env?.LC_ALL).toBe('tr_TR.UTF-8');

    // The container LOCALE stays the floor for a session that names none.
    expect((await launchWith()).env?.LANG).toBe('fr_FR.UTF-8');
  });

  it('inherits the rest of the environment rather than replacing it', async () => {
    // Playwright's `env` REPLACES the browser process environment. A
    // partial object would drop DISPLAY and leave chrome with no X
    // server to draw on.
    process.env.LOCALE = 'fr-FR';
    process.env.DISPLAY = ':99';

    expect((await launchWith()).env?.DISPLAY).toBe(':99');
  });

  it('leaves the environment alone when neither side names a locale', async () => {
    // An unset session passed no locale before this change and must
    // still impose none, or every run inherits a language nobody chose.
    const options = await launchWith();

    expect(options.locale).toBeUndefined();
    expect(options.env?.LANG).toBeUndefined();
  });

  it('takes the container USER_AGENT when the session names none, and yields to the session when it does', async () => {
    process.env.USER_AGENT = 'ContainerUA/1.0';

    expect((await launchWith()).userAgent).toBe('ContainerUA/1.0');
    expect((await launchWith({ userAgent: 'SessionUA/2.0' })).userAgent).toBe('SessionUA/2.0');
  });
});

describe('launch flags', () => {
  it('passes --test-type, a window size and a window position', async () => {
    process.env.VIEWPORT = '1280x900';

    const options = await launchWith();

    expect(options.args).toContain('--test-type');
    expect(options.args).toContain('--window-size=1280,900');
    expect(options.args).toContain('--window-position=0,0');
  });

  it('keeps the disable-features flag the scraping profile relies on', async () => {
    const options = await launchWith();

    expect(options.args.some((arg) => arg.startsWith('--disable-features='))).toBe(true);
  });

  it('turns WebGL back on through the software rasteriser', async () => {
    // Without this the container has no WebGL AT ALL: measured
    // 2026-09-05 on the live pool container, getContext returned null
    // for 'webgl', 'webgl2' and 'experimental-webgl' alike, while
    // `WebGLRenderingContext` still existed as a function. chrome://gpu
    // named the cause: "GPU process was unable to boot: GPU access is
    // disabled due to frequent crashes. Disabled Features: all".
    //
    // A desktop browser that cannot create a WebGL context is close to
    // unheard of, and every fingerprinting suite in play here (Arkose's
    // enhanced_fp, Castle, Socure, all three live in x.com's own CSP)
    // reads the WebGL vendor and renderer. Absent is rarer than
    // software-rendered.
    //
    // Three variants were launched inside the container to pick this
    // one. `--enable-unsafe-swiftshader` and
    // `--use-gl=angle --use-angle=swiftshader` both produce
    // "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)
    // (0x0000C0DE)), SwiftShader driver)". Routing ANGLE at the Mesa
    // llvmpipe device that chrome://gpu advertises as GPU0 does NOT
    // work: `--use-angle=gl` still returned null, with or without the
    // swiftshader flag. So the choice is binary, no WebGL or a
    // SwiftShader renderer string, and the llvmpipe string that would
    // have read as an ordinary driverless Linux desktop is not
    // reachable in this image.
    const options = await launchWith();

    expect(options.args).toContain('--enable-unsafe-swiftshader');
  });

  it('never passes --disable-infobars', async () => {
    // Removed from chrome's switch table; measured 2026-09-03 on the
    // live prod container to leave chromeH at 143, exactly as without
    // it. --test-type is what moves it to 87.
    const options = await launchWith();

    expect(options.args).not.toContain('--disable-infobars');
  });

  it('sizes the window from the per-session viewport ahead of the container VIEWPORT', async () => {
    process.env.VIEWPORT = '1280x900';

    const options = await launchWith({ viewport: { width: 1440, height: 900 } });

    expect(options.args).toContain('--window-size=1440,900');
    expect(options.args).not.toContain('--window-size=1280,900');
  });

  it('sizes the window at 1920x1080 when no VIEWPORT is set', async () => {
    const options = await launchWith();

    expect(options.args).toContain('--window-size=1920,1080');
  });

  it('emulates a viewport only when the session asks for one', async () => {
    // A patchright viewport is CDP metrics emulation, and for a headful
    // persistent context patchright also resizes the window to the
    // viewport plus hardcoded Linux insets (8 x 131,
    // patchright-core/lib/server/chromium/crPage.js:836-849). VIEWPORT
    // doubles as the Xvfb screen geometry (entrypoint.sh:18), so
    // emulating the container default would ask for a 1928x1211 window
    // on a 1920x1080 screen and make outerHeight - innerHeight read
    // 131 where --window-size measures the honest 87.
    process.env.VIEWPORT = '1920x1080';

    expect((await launchWith()).viewport).toBeNull();
    expect((await launchWith({ viewport: { width: 800, height: 600 } })).viewport).toEqual({
      width: 800,
      height: 600,
    });
  });
});

describe('SessionCreateSchema timezoneId', () => {
  it('accepts a timezoneId and keeps it optional', async () => {
    expect(SessionCreateSchema.parse({ timezoneId: 'Europe/Istanbul' }).timezoneId).toBe('Europe/Istanbul');
    expect(SessionCreateSchema.parse({}).timezoneId).toBeUndefined();
  });

  it('stays non-strict so an older image ignores the key instead of rejecting it', async () => {
    const parsed = SessionCreateSchema.safeParse({ timezoneId: 'UTC', somethingNewer: true });

    expect(parsed.success).toBe(true);
  });
});
