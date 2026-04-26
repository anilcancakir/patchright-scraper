import { z } from 'zod';
import type { StepExecutor } from './types.js';

const WaitUntilSchema = z
  .enum(['load', 'domcontentloaded', 'networkidle', 'commit'])
  .default('load');

const TimeoutMs = z.number().int().positive().max(120_000);

export const goto: StepExecutor = {
  name: 'goto',
  description: 'Navigate the page to a URL and wait for the chosen lifecycle event.',
  schema: z
    .object({
      url: z.string().url(),
      waitUntil: WaitUntilSchema,
      timeout: TimeoutMs.optional(),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as {
      url: string;
      waitUntil: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
      timeout?: number;
    };
    const response = await ctx.page.goto(c.url, { waitUntil: c.waitUntil, timeout: c.timeout });

    return {
      ok: true,
      output: {
        url: ctx.page.url(),
        status: response?.status() ?? null,
      },
    };
  },
};

export const reload: StepExecutor = {
  name: 'reload',
  description: 'Reload the current page and wait for the chosen lifecycle event.',
  schema: z
    .object({
      waitUntil: WaitUntilSchema,
      timeout: TimeoutMs.optional(),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as {
      waitUntil: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
      timeout?: number;
    };
    await ctx.page.reload({ waitUntil: c.waitUntil, timeout: c.timeout });

    return { ok: true, output: { url: ctx.page.url() } };
  },
};

export const goBack: StepExecutor = {
  name: 'goBack',
  description: 'Navigate back in the page history.',
  schema: z
    .object({
      waitUntil: WaitUntilSchema,
      timeout: TimeoutMs.optional(),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as {
      waitUntil: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
      timeout?: number;
    };
    await ctx.page.goBack({ waitUntil: c.waitUntil, timeout: c.timeout });

    return { ok: true, output: { url: ctx.page.url() } };
  },
};

export const goForward: StepExecutor = {
  name: 'goForward',
  description: 'Navigate forward in the page history.',
  schema: z
    .object({
      waitUntil: WaitUntilSchema,
      timeout: TimeoutMs.optional(),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as {
      waitUntil: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
      timeout?: number;
    };
    await ctx.page.goForward({ waitUntil: c.waitUntil, timeout: c.timeout });

    return { ok: true, output: { url: ctx.page.url() } };
  },
};
