import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makePage } from '../steps/_helpers.js';

/**
 * The sandbox request is half of a pair, and this file guards the half
 * that lives in the image.
 *
 * Playwright's `launchPersistentContext` defaults to
 * `chromiumSandbox: false`, which is where `--no-sandbox` comes from;
 * nothing in this source passes the flag. Running chrome sandboxed
 * needs the container to have been created with a seccomp profile that
 * allows an unprivileged namespace-creating `clone`, and the
 * provisioner marks such a container by setting `CHROME_SANDBOX=1` in
 * the same launch spec that carries the grant.
 *
 * Asking for the sandbox unconditionally would break every container
 * that predates the grant: the pool provisioner only invalidates a
 * stopped container on an image-digest change, so an old container
 * keeps its old HostConfig and a sandboxed chrome would fail to start
 * inside it. Reading the env key is what makes the two deploys
 * order-independent.
 */
const { launchPersistentContext } = vi.hoisted(() => ({
  launchPersistentContext: vi.fn(),
}));

vi.mock('patchright', () => ({
  chromium: { launchPersistentContext },
}));

interface LaunchOptions {
  chromiumSandbox?: boolean;
}

const MANAGED_ENV = ['CHROME_SANDBOX', 'DISPLAY', 'PROFILE_ROOT', 'PROFILE_DIR', 'PATCHRIGHT_LAUNCH_SETTLE_MS'] as const;

let savedEnv: Record<string, string | undefined> = {};

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
 * Re-import per launch: the env is read at module scope, so a cached
 * import would answer with the previous test's grant.
 */
async function launchWith(): Promise<LaunchOptions> {
  vi.resetModules();
  const { createSession } = await import('../../src/session.js');
  await createSession({ captureTraffic: false } as never);

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

  process.env.PROFILE_ROOT = mkdtempSync(join(tmpdir(), 'kdz-sandbox-flag-'));
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

describe('chrome sandbox request', () => {
  it('asks for the sandbox when the container carries the grant', async () => {
    process.env.CHROME_SANDBOX = '1';

    expect((await launchWith()).chromiumSandbox).toBe(true);
  });

  it('passes no sandbox option at all when the grant is absent', async () => {
    // The backward-compatibility guarantee. Every container created
    // before the grant existed takes this path, so the key has to be
    // absent rather than false: absent leaves playwright's own default
    // in charge, which is what those containers boot with today.
    const options = await launchWith();

    expect('chromiumSandbox' in options).toBe(false);
  });

  it('treats any value other than 1 as no grant', async () => {
    // Env values are strings, and '0' is truthy in JS. A container that
    // was handed CHROME_SANDBOX=0 must not end up sandboxed.
    process.env.CHROME_SANDBOX = '0';

    expect('chromiumSandbox' in (await launchWith())).toBe(false);
  });
});
