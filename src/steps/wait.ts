import { z } from 'zod';
import { LocatorSpec, resolveLocator } from './locator.js';
import type { StepExecutor } from './types.js';

const TimeoutMs = z.number().int().positive().max(120_000);

export const waitForSelector: StepExecutor = {
  name: 'waitForSelector',
  description: 'Wait until a locator reaches the desired DOM state.',
  schema: z
    .object({
      locator: LocatorSpec,
      state: z.enum(['attached', 'detached', 'visible', 'hidden']).default('visible'),
      timeout: TimeoutMs.default(10_000),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as {
      locator: LocatorSpec;
      state: 'attached' | 'detached' | 'visible' | 'hidden';
      timeout: number;
    };
    const locator = resolveLocator(ctx.page, c.locator);
    await locator.waitFor({ state: c.state, timeout: c.timeout });

    return { ok: true, output: { state: c.state } };
  },
};

export const waitForLoadState: StepExecutor = {
  name: 'waitForLoadState',
  description: 'Wait for the page to reach a lifecycle event.',
  schema: z
    .object({
      state: z.enum(['load', 'domcontentloaded', 'networkidle']).default('networkidle'),
      timeout: TimeoutMs.default(10_000),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as { state: 'load' | 'domcontentloaded' | 'networkidle'; timeout: number };
    await ctx.page.waitForLoadState(c.state, { timeout: c.timeout });

    return { ok: true, output: { state: c.state } };
  },
};

export const waitForTimeout: StepExecutor = {
  name: 'waitForTimeout',
  description: 'Block the scenario for a fixed number of milliseconds.',
  schema: z
    .object({
      ms: z.number().int().nonnegative(),
    })
    .strict(),
  async execute(_ctx, config) {
    const c = config as { ms: number };
    await new Promise((resolve) => setTimeout(resolve, c.ms));

    return { ok: true, output: { waitedMs: c.ms } };
  },
};

export const waitForURL: StepExecutor = {
  name: 'waitForURL',
  description: 'Wait until the page URL matches the supplied string or pattern.',
  schema: z
    .object({
      url: z.string().min(1),
      regex: z.boolean().default(false),
      waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle', 'commit']).default('load'),
      timeout: TimeoutMs.default(30_000),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as {
      url: string;
      regex: boolean;
      waitUntil: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
      timeout: number;
    };
    const matcher = c.regex ? new RegExp(c.url) : c.url;
    await ctx.page.waitForURL(matcher, { waitUntil: c.waitUntil, timeout: c.timeout });

    return { ok: true, output: { url: ctx.page.url() } };
  },
};

export const waitForFunction: StepExecutor = {
  name: 'waitForFunction',
  description: 'Wait until a JS expression evaluated in the page returns truthy.',
  schema: z
    .object({
      expression: z.string().min(1),
      args: z.array(z.unknown()).default([]),
      polling: z.union([z.number().int().positive(), z.literal('raf')]).default('raf'),
      timeout: TimeoutMs.default(30_000),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as {
      expression: string;
      args: unknown[];
      polling: number | 'raf';
      timeout: number;
    };

    const result = await ctx.page.waitForFunction(
      ({ expr, args }) => {
        // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
        const fn = new Function('args', `return (${expr}).apply(null, args);`);
        return fn(args);
      },
      { expr: c.expression, args: c.args },
      { polling: c.polling, timeout: c.timeout },
    );

    return { ok: true, output: { resolved: result !== null } };
  },
};
