import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makePage } from '../steps/_helpers.js';

/**
 * The two halves of a browser dying under the sidecar, measured on
 * 2026-09-21.
 *
 * Chrome's shared memory lived in /tmp, on the Docker host's disk, because
 * playwright launches chrome with `--disable-dev-shm-usage`. When that disk
 * filled, the next navigation killed the browser: reproduced by filling a
 * 200 MB /tmp in a throwaway container, where the first goto answered
 * `Target page, context or browser has been closed`. The container is given
 * a 1 GiB /dev/shm for exactly this, so the flag comes off.
 *
 * And the session kept answering `active` over a browser that was gone, so
 * the caller reused it six times before an operator deleted it by hand.
 */
const { launchPersistentContext } = vi.hoisted(() => ({
  launchPersistentContext: vi.fn(),
}));

vi.mock('patchright', () => ({
  chromium: { launchPersistentContext },
}));

interface LaunchOptions {
  ignoreDefaultArgs?: string[] | boolean;
}

const MANAGED_ENV = ['DISPLAY', 'PROFILE_ROOT', 'PROFILE_DIR', 'PATCHRIGHT_LAUNCH_SETTLE_MS'] as const;

let savedEnv: Record<string, string | undefined> = {};
let closeHandlers: Array<() => void> = [];

function makeBrowserContext(): Record<string, unknown> {
  const page = makePage();

  return {
    pages: () => [page],
    newPage: async () => page,
    route: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    on: vi.fn((event: string, handler: () => void) => {
      if (event === 'close') {
        closeHandlers.push(handler);
      }
    }),
  };
}

beforeEach(() => {
  savedEnv = {};
  for (const key of MANAGED_ENV) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }

  process.env.PROFILE_ROOT = mkdtempSync(join(tmpdir(), 'kdz-browser-death-'));
  process.env.PATCHRIGHT_LAUNCH_SETTLE_MS = '0';

  closeHandlers = [];
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

describe('a browser that dies under the sidecar', () => {
  it('keeps shared memory on /dev/shm rather than the host disk', async () => {
    vi.resetModules();
    const { createSession } = await import('../../src/session.js');
    await createSession({ captureTraffic: false } as never);

    const options = launchPersistentContext.mock.calls.at(-1)?.[1] as LaunchOptions;

    expect(options.ignoreDefaultArgs).toEqual(['--disable-dev-shm-usage']);
  });

  it('relaunches rather than handing back a session whose browser is gone', async () => {
    // Pool mode mints by the caller's own id and forgets nothing, so a
    // dead session handed back is driven for good: every reuse pushes
    // `lastUsedAt` forward and the idle reaper never collects it.
    vi.resetModules();
    const { createSession } = await import('../../src/session.js');
    const first = await createSession({ sessionId: 'reused', captureTraffic: false } as never);

    for (const handler of closeHandlers) {
      handler();
    }

    const second = await createSession({ sessionId: 'reused', captureTraffic: false } as never);

    expect(second.state).toBe('active');
    expect(second).not.toBe(first);
    expect(launchPersistentContext).toHaveBeenCalledTimes(2);
  });

  it('stops answering active once its context has closed', async () => {
    vi.resetModules();
    const { createSession, getSession } = await import('../../src/session.js');
    const session = await createSession({ captureTraffic: false } as never);

    expect(getSession(session.id)?.state).toBe('active');

    for (const handler of closeHandlers) {
      handler();
    }

    expect(getSession(session.id)?.state).toBe('closed');
  });
});
