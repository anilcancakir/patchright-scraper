import { chromium, type BrowserContext, type Page } from 'patchright';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionCreate } from './types.js';
import type { SessionState } from './steps/types.js';

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
}

const sessions = new Map<string, ManagedSession>();
const PROFILE_ROOT = process.env.PROFILE_ROOT ?? process.env.PROFILE_DIR ?? '/data/profiles';
const IDLE_TIMEOUT_MS = Number(process.env.SESSION_IDLE_MS ?? 10 * 60 * 1000);

export interface CreateSessionInput extends SessionCreate {
  loginSignature?: string;
  identityHash?: string;
}

/**
 * Open (or look up) a long-lived persistent context. The page handle
 * lives on the session so step executors share it across calls.
 */
export async function createSession(input: CreateSessionInput): Promise<ManagedSession> {
  const id = input.sessionId ?? randomUUID();

  const existing = sessions.get(id);
  if (existing !== undefined) {
    existing.lastUsedAt = Date.now();

    return existing;
  }

  const subdir = input.identityHash ?? id;
  const profilePath = join(PROFILE_ROOT, subdir);
  mkdirSync(profilePath, { recursive: true });

  const context = await chromium.launchPersistentContext(profilePath, {
    channel: 'chrome',
    headless: process.env.DISPLAY ? false : true,
    proxy: input.proxy,
    userAgent: input.userAgent,
    locale: input.locale,
    viewport: input.viewport ?? null,
  });

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
  };

  sessions.set(id, session);

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
  }

  return true;
}

export function listSessions(): Array<{ id: string; createdAt: number; lastUsedAt: number; state: SessionState }> {
  return Array.from(sessions.values()).map((s) => ({
    id: s.id,
    createdAt: s.createdAt,
    lastUsedAt: s.lastUsedAt,
    state: s.state,
  }));
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
 * Periodic reaper: closes sessions idle longer than the configured
 * threshold. Started from server.ts and shut down on SIGTERM.
 */
export function startIdleReaper(): NodeJS.Timeout {
  return setInterval(async () => {
    const cutoff = Date.now() - IDLE_TIMEOUT_MS;

    for (const [id, session] of sessions.entries()) {
      if (session.lastUsedAt > cutoff) {
        continue;
      }

      session.state = 'idle';

      try {
        await session.context.close();
      } catch {
        // ignore: context may already be detached
      }
      sessions.delete(id);
    }
  }, 30_000);
}

export type { ManagedSession };
