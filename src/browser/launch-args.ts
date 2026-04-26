/**
 * Resolves browser launch options from environment variables. Lets the
 * same image run pool-mode (headless, no display) and automation-mode
 * (headed, Xvfb-backed) without code changes.
 */

export interface ResolvedLaunchArgs {
  headless: boolean;
  userAgent?: string;
  locale: string;
  timezoneId: string;
  viewport: { width: number; height: number };
  extraArgs: string[];
  proxy?: { server: string; username?: string; password?: string };
}

const DEFAULT_VIEWPORT = { width: 1920, height: 1080 };

/**
 * Read env-driven launch options. Each helper has a deterministic default
 * so an unset env never crashes a launch.
 */
export function resolveLaunchArgs(env: NodeJS.ProcessEnv = process.env): ResolvedLaunchArgs {
  return {
    headless: resolveHeadless(env),
    userAgent: env.USER_AGENT,
    locale: env.LOCALE ?? 'en-US',
    timezoneId: env.TIMEZONE ?? 'UTC',
    viewport: resolveViewport(env.VIEWPORT),
    extraArgs: resolveExtraArgs(env.EXTRA_LAUNCH_ARGS_JSON),
    proxy: resolveProxy(env.PROXY),
  };
}

/**
 * `auto` (default): headed when DISPLAY is set (Xvfb running), headless
 * otherwise. Explicit `0` / `1` overrides.
 */
function resolveHeadless(env: NodeJS.ProcessEnv): boolean {
  const value = (env.HEADLESS ?? 'auto').toLowerCase();
  if (value === '0' || value === 'false') return false;
  if (value === '1' || value === 'true') return true;
  return env.DISPLAY === undefined || env.DISPLAY === '';
}

function resolveViewport(raw: string | undefined): { width: number; height: number } {
  if (raw === undefined || raw === '') {
    return DEFAULT_VIEWPORT;
  }

  const match = raw.match(/^(\d+)x(\d+)$/);
  if (match === null) {
    return DEFAULT_VIEWPORT;
  }

  const [, w, h] = match;
  const width = Number(w);
  const height = Number(h);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return DEFAULT_VIEWPORT;
  }

  return { width, height };
}

function resolveExtraArgs(raw: string | undefined): string[] {
  if (raw === undefined || raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === 'string');
  } catch {
    return [];
  }
}

/**
 * Parse `host:port` or `host:port:user:pass` into Patchright's proxy shape.
 * Returns undefined when the value is missing or malformed.
 */
function resolveProxy(raw: string | undefined): { server: string; username?: string; password?: string } | undefined {
  if (raw === undefined || raw === '') return undefined;

  const parts = raw.split(':');
  if (parts.length !== 2 && parts.length !== 4) return undefined;

  const [host, port, username, password] = parts;
  if (host === undefined || port === undefined || host === '' || port === '') return undefined;

  const result: { server: string; username?: string; password?: string } = {
    server: `http://${host}:${port}`,
  };
  if (parts.length === 4 && username !== undefined && password !== undefined) {
    result.username = username;
    result.password = password;
  }
  return result;
}
