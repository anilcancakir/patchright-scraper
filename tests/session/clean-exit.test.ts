import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makePage } from '../steps/_helpers.js';

/**
 * A profile that reads "crashed" costs a recipe, not just a tidy log.
 *
 * Chromium writes `profile.exit_type` = "Crashed" at startup and flips
 * it to "Normal" only during a clean shutdown (kSessionExitType,
 * chrome/common/pref_names.h). Nothing here shut Chrome down, so every
 * container stop left the marker set and the next launch opened on the
 * "Restore pages?" bubble, over the top right of the page, where the
 * site's own controls live. On a dedicated account the profile is the
 * identity and therefore always the same profile, so it happened every
 * time.
 *
 * Clearing the marker at launch is what carries this. Closing the
 * contexts on SIGTERM was written to stop the marker being written at
 * all and does not: measured on prod 2026-09-06, a stop logged
 * `closed: 1`, left no chrome process behind, and the released profile
 * still read "Crashed". It stays for the smaller thing it does, which
 * is letting Chrome flush and release its own guards rather than be
 * killed mid-write, and is tested for that rather than for the pref.
 */
const { launchPersistentContext } = vi.hoisted(() => ({
  launchPersistentContext: vi.fn(),
}));

vi.mock('patchright', () => ({
  chromium: { launchPersistentContext },
}));

const MANAGED_ENV = ['PROFILE_ROOT', 'PROFILE_DIR', 'DISPLAY', 'PATCHRIGHT_LAUNCH_SETTLE_MS'] as const;

let savedEnv: Record<string, string | undefined> = {};

function makeBrowserContext(close?: () => Promise<void>): Record<string, unknown> {
  const page = makePage();

  return {
    pages: () => [page],
    newPage: async () => page,
    route: vi.fn(async () => undefined),
    close: vi.fn(close ?? (async () => undefined)),
  };
}

beforeEach(() => {
  savedEnv = {};
  for (const key of MANAGED_ENV) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }

  process.env.PROFILE_ROOT = mkdtempSync(join(tmpdir(), 'kdz-clean-exit-'));
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

describe('the crash marker a killed Chrome leaves behind', () => {
  it('is cleared before the profile is opened again', async () => {
    // The life that wrote this one ended in SIGKILL, so no shutdown
    // handler ran and nothing could have flipped it.
    const root = process.env.PROFILE_ROOT as string;
    const defaultDir = join(root, 'acct', 'Default');
    mkdirSync(defaultDir, { recursive: true });
    writeFileSync(
      join(defaultDir, 'Preferences'),
      JSON.stringify({ profile: { exit_type: 'Crashed', name: 'Person 1' } }),
    );

    vi.resetModules();
    const { createSession } = await import('../../src/session.js');
    await createSession({ captureTraffic: false, identityHash: 'acct' } as never);

    const prefs = JSON.parse(readFileSync(join(defaultDir, 'Preferences'), 'utf8'));

    expect(prefs.profile.exit_type).toBe('Normal');
    // The seed rewrites the whole file, so anything it does not know
    // about has to survive the rewrite: this profile is the account.
    expect(prefs.profile.name).toBe('Person 1');
  });

  it('is declared normal on a profile that has none yet', async () => {
    // A first launch writes no marker at all, and Chrome reads a
    // missing exit_type as unclean.
    vi.resetModules();
    const { createSession } = await import('../../src/session.js');
    await createSession({ captureTraffic: false, identityHash: 'fresh' } as never);

    const prefs = JSON.parse(
      readFileSync(join(process.env.PROFILE_ROOT as string, 'fresh', 'Default', 'Preferences'), 'utf8'),
    );

    expect(prefs.profile.exit_type).toBe('Normal');
  });
});

describe('closeAllSessions', () => {
  it('closes every live context so Chrome flushes instead of being killed', async () => {
    vi.resetModules();
    const { createSession, closeAllSessions, listSessions } = await import('../../src/session.js');

    const closes: string[] = [];
    launchPersistentContext.mockImplementation(async () =>
      makeBrowserContext(async () => {
        closes.push('closed');
      }),
    );

    await createSession({ captureTraffic: false, identityHash: 'a' } as never);
    await createSession({ captureTraffic: false, identityHash: 'b' } as never);

    await expect(closeAllSessions(1_000)).resolves.toBe(2);

    expect(closes).toHaveLength(2);
    expect(listSessions()).toHaveLength(0);
  });

  it('gives up on a context that will not close rather than spending the grace period', async () => {
    // `containerStop` grants ten seconds before SIGKILL. A context that
    // hangs must not be allowed to spend them: the kill lands anyway, so
    // waiting buys nothing and costs whatever would have closed behind
    // it.
    vi.resetModules();
    const { createSession, closeAllSessions } = await import('../../src/session.js');

    launchPersistentContext.mockImplementation(async () =>
      makeBrowserContext(() => new Promise(() => undefined)),
    );

    await createSession({ captureTraffic: false, identityHash: 'wedged' } as never);

    const startedAt = Date.now();
    await expect(closeAllSessions(50)).resolves.toBe(0);

    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('answers on a container that never opened a browser', async () => {
    // Every stop calls it, including the stops with nothing to close.
    vi.resetModules();
    const { closeAllSessions } = await import('../../src/session.js');

    await expect(closeAllSessions(1_000)).resolves.toBe(0);
  });
});
