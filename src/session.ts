import { chromium, type BrowserContext } from 'patchright';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionCreate } from './types.js';

interface ManagedSession {
  id: string;
  context: BrowserContext;
  profilePath: string;
  createdAt: number;
  lastUsedAt: number;
}

const sessions = new Map<string, ManagedSession>();
const PROFILE_ROOT = process.env.PROFILE_ROOT ?? '/data/profiles';
const IDLE_TIMEOUT_MS = Number(process.env.SESSION_IDLE_MS ?? 10 * 60 * 1000);

/**
 * Open (or look up) a long-lived persistent context. Returning the
 * managed wrapper rather than just the BrowserContext lets the
 * routes layer keep timestamps current.
 */
export async function createSession(input: SessionCreate): Promise<ManagedSession> {
  const id = input.sessionId ?? randomUUID();

  const existing = sessions.get(id);
  if (existing !== undefined) {
    existing.lastUsedAt = Date.now();

    return existing;
  }

  const profilePath = join(PROFILE_ROOT, id);
  mkdirSync(profilePath, { recursive: true });

  const context = await chromium.launchPersistentContext(profilePath, {
    channel: 'chrome',
    headless: true,
    proxy: input.proxy,
    userAgent: input.userAgent,
    locale: input.locale,
    viewport: input.viewport ?? null,
  });

  const session: ManagedSession = {
    id,
    context,
    profilePath,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
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

  try {
    await session.context.close();
  } finally {
    sessions.delete(id);
  }

  return true;
}

export function listSessions(): Array<{ id: string; createdAt: number; lastUsedAt: number }> {
  return Array.from(sessions.values()).map((s) => ({
    id: s.id,
    createdAt: s.createdAt,
    lastUsedAt: s.lastUsedAt,
  }));
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

      try {
        await session.context.close();
      } catch {
        // ignore: context may already be detached
      }
      sessions.delete(id);
    }
  }, 30_000);
}
