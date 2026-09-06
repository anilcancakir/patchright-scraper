import { z } from 'zod';
import {
  LocatorSpec,
  type LocatorCandidate,
  resolveLocator,
  resolveLocatorOrFirst,
} from './locator.js';

type Candidates = LocatorCandidate[];
import type { StepExecutor } from './types.js';
import { sampleKeystrokeGap } from './input.js';

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
      locator: Candidates;
      state: 'attached' | 'detached' | 'visible' | 'hidden';
      timeout: number;
    };
    // The resolver depends on what is being waited FOR.
    //
    // 'attached' and 'visible' mean "appear", which is the whole reason
    // this step exists: the element is usually not there yet, so a
    // single-sweep resolver would find nothing, fall back to candidate 0
    // and wait on that alone. Every fallback in the chain would be dead
    // and the step would report locatorIndex 0 forever. Poll instead.
    //
    // 'detached' and 'hidden' mean "go away", and those are satisfied BY
    // nothing matching, so a resolver that threw on an empty page would
    // turn a passing wait into an error.
    const appearing = c.state === 'attached' || c.state === 'visible';

    const target = appearing
      ? await resolveLocator(ctx.page, c.locator, c.timeout)
      : await resolveLocatorOrFirst(ctx.page, c.locator);

    await target.locator.waitFor({
      state: c.state,
      timeout: appearing ? target.remainingMs : c.timeout,
    });

    return { ok: true, output: { state: c.state, locatorIndex: target.index } };
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
  description:
    'Block the scenario, either for an exact number of milliseconds or for a human-shaped draw around it.',
  schema: z
    .object({
      ms: z.number().int().nonnegative(),
      jitter: z.boolean().default(false),
    })
    .strict(),
  /**
   * `jitter` is for a dwell rather than a deadline.
   *
   * A recipe that pauses to look like someone reading, and pauses for
   * exactly the same 9000ms on every run, has replaced "no idle time at
   * all" with "an idle time nobody has twice". The draw comes from the
   * same lognormal as the keystroke gap: right-skewed, so most reads are
   * near the nominal and the occasional one is much longer, which is the
   * shape attention actually has.
   *
   * Off by default. A wait used to let a fixed animation finish wants the
   * number it was given, and every stored recipe was written against one.
   */
  async execute(_ctx, config) {
    const c = config as { ms: number; jitter: boolean };
    const waitedMs = c.jitter && c.ms > 0 ? sampleKeystrokeGap(c.ms) : c.ms;

    await new Promise((resolve) => setTimeout(resolve, waitedMs));

    return { ok: true, output: { waitedMs } };
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
