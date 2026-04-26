import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext } from 'patchright';

export interface StealthProfile {
  userAgent?: string;
  locale?: string;
  timezoneId?: string;
  viewport?: { width: number; height: number };
  extraHTTPHeaders?: Record<string, string>;
  geolocation?: { longitude: number; latitude: number; accuracy?: number };
}

const BUILT_IN_PROFILES: Record<string, StealthProfile> = {
  desktop: {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'UTC',
    viewport: { width: 1920, height: 1080 },
    extraHTTPHeaders: { 'accept-language': 'en-US,en;q=0.9' },
  },
  'mobile-tr': {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    locale: 'tr-TR',
    timezoneId: 'Europe/Istanbul',
    viewport: { width: 390, height: 844 },
    extraHTTPHeaders: { 'accept-language': 'tr-TR,tr;q=0.9,en-US;q=0.8' },
  },
  googlebot: {
    userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    locale: 'en-US',
    timezoneId: 'UTC',
    viewport: { width: 1920, height: 1080 },
    extraHTTPHeaders: { 'accept-language': 'en-US,en;q=0.5' },
  },
};

/**
 * Resolve the active fingerprint profile. Custom JSON file takes
 * precedence over the built-in name.
 */
export function resolveFingerprintProfile(env: NodeJS.ProcessEnv = process.env): StealthProfile | undefined {
  const filePath = env.FINGERPRINT_PROFILE_FILE;
  if (filePath !== undefined && filePath !== '') {
    try {
      const raw = readFileSync(filePath, 'utf8');
      return JSON.parse(raw) as StealthProfile;
    } catch {
      // fall through to built-in
    }
  }

  const name = env.FINGERPRINT_PROFILE;
  if (name === undefined || name === '') return undefined;

  return BUILT_IN_PROFILES[name];
}

/**
 * Apply stealth init scripts: every `*.js` file under JS_INJECTIONS_DIR
 * is `addInitScript`-injected so it runs in every navigated page.
 */
export async function applyStealthInjections(
  context: BrowserContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const dir = env.JS_INJECTIONS_DIR ?? '/data/inject';

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }

  let count = 0;
  for (const entry of entries) {
    if (!entry.endsWith('.js')) continue;
    try {
      const script = readFileSync(join(dir, entry), 'utf8');
      await context.addInitScript({ content: script });
      count += 1;
    } catch {
      // ignore unreadable files; surface real errors via the integration smoke
    }
  }
  return count;
}

/**
 * Return chromium launch flags driven by `PATCHRIGHT_STEALTH_LEVEL`.
 * `basic` is what the upstream patchright already does; `aggressive`
 * piles on extra spoofing flags useful against fingerprinting checks.
 */
export function resolveStealthFlags(env: NodeJS.ProcessEnv = process.env): string[] {
  const level = (env.PATCHRIGHT_STEALTH_LEVEL ?? 'basic').toLowerCase();
  if (level === 'aggressive') {
    return [
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-site-isolation-trials',
    ];
  }
  return [];
}
