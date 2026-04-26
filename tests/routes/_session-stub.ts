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

function buildPage(): never {
  return {
    url: () => stub.url ?? 'https://example.org/',
    goto: stub.gotoSpy ?? (async () => ({ status: () => 200 })),
    reload: async () => ({ status: () => 200 }),
    goBack: async () => null,
    waitForSelector: async () => ({
      evaluate: async () => undefined,
      innerText: async () => '',
      getAttribute: async () => null,
      screenshot: async () => Buffer.from(''),
    }),
    waitForLoadState: async () => undefined,
    click: async () => undefined,
    type: async () => undefined,
    fill: async () => undefined,
    press: async () => undefined,
    keyboard: { press: async () => undefined },
    selectOption: async () => [],
    check: async () => undefined,
    uncheck: async () => undefined,
    setInputFiles: async () => undefined,
    screenshot: async () => Buffer.from(''),
    content: async () => '',
    evaluate: async () => undefined,
    setViewportSize: async () => undefined,
  } as never;
}

function buildSession(): ManagedSession {
  return {
    id: stub.id ?? 'stub',
    context: {} as never,
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
