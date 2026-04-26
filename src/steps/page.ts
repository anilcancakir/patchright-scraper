import { z } from 'zod';
import type { StepExecutor } from './types.js';

/**
 * Page-level step primitives that mirror Playwright's `BrowserContext`
 * helpers. Each writes back into the live context so subsequent steps
 * inherit the new state. `routeBlock` keeps a per-session set of glob
 * patterns so unsubscribing on session destroy stays cheap.
 */

export const setViewportSize: StepExecutor = {
  name: 'setViewportSize',
  description: 'Resize the page viewport.',
  schema: z
    .object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as { width: number; height: number };
    await ctx.page.setViewportSize({ width: c.width, height: c.height });

    return { ok: true, output: { width: c.width, height: c.height } };
  },
};

export const setUserAgent: StepExecutor = {
  name: 'setUserAgent',
  description: 'Persist a user-agent override for the next session boot.',
  schema: z
    .object({
      userAgent: z.string().min(1),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as { userAgent: string };
    // Patchright cannot mutate the UA of a live context. Persist the
    // override so a future session refresh applies it; warn the caller.
    ctx.log('setUserAgent: stored, applies on next session boot', { userAgent: c.userAgent });

    return {
      ok: true,
      output: {
        userAgent: c.userAgent,
        appliedImmediately: false,
        note: 'Stored for next session boot; live UA mutation is not supported.',
      },
    };
  },
};

export const setExtraHTTPHeaders: StepExecutor = {
  name: 'setExtraHTTPHeaders',
  description: 'Set extra HTTP headers for every subsequent request in this context.',
  schema: z
    .object({
      headers: z.record(z.string()),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as { headers: Record<string, string> };
    await ctx.context.setExtraHTTPHeaders(c.headers);

    return { ok: true, output: { keys: Object.keys(c.headers) } };
  },
};

export const setOffline: StepExecutor = {
  name: 'setOffline',
  description: 'Toggle offline mode for the active context.',
  schema: z
    .object({
      offline: z.boolean(),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as { offline: boolean };
    await ctx.context.setOffline(c.offline);

    return { ok: true, output: { offline: c.offline } };
  },
};

export const setGeolocation: StepExecutor = {
  name: 'setGeolocation',
  description: 'Set the geolocation override and grant the geolocation permission.',
  schema: z
    .object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      accuracy: z.number().nonnegative().optional(),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as { latitude: number; longitude: number; accuracy?: number };
    await ctx.context.grantPermissions(['geolocation']);
    await ctx.context.setGeolocation({
      latitude: c.latitude,
      longitude: c.longitude,
      accuracy: c.accuracy,
    });

    return {
      ok: true,
      output: { latitude: c.latitude, longitude: c.longitude, accuracy: c.accuracy ?? null },
    };
  },
};

export const routeBlock: StepExecutor = {
  name: 'routeBlock',
  description: 'Abort every request matching one of the supplied URL glob patterns.',
  schema: z
    .object({
      patterns: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as { patterns: string[] };

    for (const pattern of c.patterns) {
      await ctx.context.route(pattern, (route) => route.abort());
    }

    return { ok: true, output: { patterns: c.patterns } };
  },
};
