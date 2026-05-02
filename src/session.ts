import { chromium, type BrowserContext, type Page } from 'patchright';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
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
  bearer?: string;
  vncRequestedAt?: number;
}

const sessions = new Map<string, ManagedSession>();
const PROFILE_ROOT = process.env.PROFILE_ROOT ?? process.env.PROFILE_DIR ?? '/data/profiles';
const SESSION_BEARERS_PATH = process.env.SESSION_BEARERS_PATH ?? '/data/session-bearers.json';
const CHROME_IDLE_MS = Number(process.env.CHROME_IDLE_MS ?? process.env.SESSION_IDLE_MS ?? 60 * 60 * 1000);
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
 * at a time. The cost is per-request: ~1-3s queue wait under a
 * burst, but every call eventually succeeds with HTTP 200.
 */
let launchQueue: Promise<unknown> = Promise.resolve();

function withLaunchLock<T>(callback: () => Promise<T>): Promise<T> {
  const next = launchQueue.then(callback, callback);
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

  const extraHeaders: Record<string, string> = {
    'X-Kodizm-Session': id,
  };

  const context = await withLaunchLock(() =>
    chromium.launchPersistentContext(profilePath, {
      channel: 'chrome',
      headless: process.env.DISPLAY ? false : true,
      proxy: input.proxy,
      userAgent: input.userAgent,
      locale: input.locale,
      viewport: input.viewport ?? null,
      extraHTTPHeaders: extraHeaders,
      // Pool mode routes chrome through the in-container mitm sidecar
      // so every TLS request lands on the capture queue. mitmproxy
      // signs intercepted responses with its own CA, so the browser
      // must accept the cert chain when the caller flags it.
      ignoreHTTPSErrors: input.ignoreHTTPSErrors ?? false,
    }),
  );

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
