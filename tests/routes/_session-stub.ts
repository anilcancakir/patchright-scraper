import { vi } from 'vitest';
import type { ManagedSession } from '../../src/session.js';
import type { SessionState } from '../../src/steps/types.js';

interface StubFields {
  id?: string;
  state?: SessionState;
  url?: string;
  gotoSpy?: ReturnType<typeof vi.fn>;
}

let stub: StubFields = {};

export function __setStub(fields: StubFields): void {
  stub = fields;
}

export function __resetStub(): void {
  stub = {};
}

function buildLocator(): unknown {
  return {
    click: async () => undefined,
    fill: async () => undefined,
    type: async () => undefined,
    press: async () => undefined,
    hover: async () => undefined,
    focus: async () => undefined,
    blur: async () => undefined,
    dblclick: async () => undefined,
    dragTo: async () => undefined,
    scrollIntoViewIfNeeded: async () => undefined,
    selectOption: async () => [],
    check: async () => undefined,
    uncheck: async () => undefined,
    setInputFiles: async () => undefined,
    innerText: async () => '',
    inputValue: async () => '',
    getAttribute: async () => null,
    isVisible: async () => true,
    isEnabled: async () => true,
    isDisabled: async () => false,
    isChecked: async () => false,
    count: async () => 1,
    evaluate: async () => undefined,
    screenshot: async () => Buffer.from(''),
    waitFor: async () => undefined,
  };
}

function buildPage(): never {
  const locator = buildLocator();
  const lookup = (): unknown => locator;

  return {
    url: () => stub.url ?? 'https://example.org/',
    goto: stub.gotoSpy ?? (async () => ({ status: () => 200 })),
    reload: async () => ({ status: () => 200 }),
    goBack: async () => null,
    goForward: async () => null,
    waitForSelector: async () => locator,
    waitForLoadState: async () => undefined,
    waitForURL: async () => undefined,
    waitForFunction: async () => null,
    keyboard: { press: async () => undefined },
    screenshot: async () => Buffer.from(''),
    content: async () => '',
    title: async () => 'stub',
    evaluate: async () => undefined,
    setViewportSize: async () => undefined,
    locator: lookup,
    getByRole: lookup,
    getByText: lookup,
    getByLabel: lookup,
    getByPlaceholder: lookup,
    getByTestId: lookup,
    getByAltText: lookup,
    getByTitle: lookup,
  } as never;
}

function buildContext(): never {
  return {
    setExtraHTTPHeaders: async () => undefined,
    setOffline: async () => undefined,
    setGeolocation: async () => undefined,
    grantPermissions: async () => undefined,
    route: async () => undefined,
  } as never;
}

function buildSession(): ManagedSession {
  return {
    id: stub.id ?? 'stub',
    context: buildContext(),
    page: buildPage(),
    profilePath: '/tmp/stub',
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    state: stub.state ?? 'active',
  };
}

export async function createSession(input: { sessionId?: string }): Promise<ManagedSession> {
  stub = { ...stub, id: input.sessionId ?? 'stub' };
  return buildSession();
}

export function getSession(id: string): ManagedSession | undefined {
  if (stub.id !== undefined && stub.id !== id) {
    return undefined;
  }
  if (stub.id === undefined) {
    return undefined;
  }
  return buildSession();
}

export async function destroySession(_id: string): Promise<boolean> {
  return true;
}

export function listSessions(): unknown[] {
  return [];
}

export function refreshState(session: ManagedSession): SessionState {
  return session.state;
}

export function startIdleReaper(): NodeJS.Timeout {
  return setInterval(() => undefined, 1_000_000);
}
