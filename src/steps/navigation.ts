import { z } from 'zod';
import type { StepExecutor } from './types.js';

const WaitUntilSchema = z
  .enum(['load', 'domcontentloaded', 'networkidle', 'commit'])
  .default('load');

export const goto: StepExecutor = {
  name: 'goto',
  schema: z.object({
    url: z.string().url(),
    wait_until: WaitUntilSchema,
    timeout_ms: z.number().int().positive().max(120_000).optional(),
  }),
  async execute(ctx, config) {
    const { url, wait_until, timeout_ms } = config as { url: string; wait_until: 'load' | 'domcontentloaded' | 'networkidle' | 'commit'; timeout_ms?: number };
    const response = await ctx.page.goto(url, { waitUntil: wait_until, timeout: timeout_ms });

    return {
      ok: true,
      output: {
        url: ctx.page.url(),
        status: response?.status() ?? null,
      },
    };
  },
};

export const wait_for: StepExecutor = {
  name: 'wait_for',
  schema: z.discriminatedUnion('mode', [
    z.object({
      mode: z.literal('selector'),
      selector: z.string(),
      state: z.enum(['attached', 'detached', 'visible', 'hidden']).default('visible'),
      timeout_ms: z.number().int().positive().default(10_000),
    }),
    z.object({
      mode: z.literal('load_state'),
      state: z.enum(['load', 'domcontentloaded', 'networkidle']).default('networkidle'),
      timeout_ms: z.number().int().positive().default(10_000),
    }),
    z.object({
      mode: z.literal('timeout'),
      ms: z.number().int().positive(),
    }),
  ]),
  async execute(ctx, config) {
    const c = config as
      | { mode: 'selector'; selector: string; state: 'attached' | 'detached' | 'visible' | 'hidden'; timeout_ms: number }
      | { mode: 'load_state'; state: 'load' | 'domcontentloaded' | 'networkidle'; timeout_ms: number }
      | { mode: 'timeout'; ms: number };

    if (c.mode === 'selector') {
      await ctx.page.waitForSelector(c.selector, { state: c.state, timeout: c.timeout_ms });
      return { ok: true, output: { matched: c.selector } };
    }

    if (c.mode === 'load_state') {
      await ctx.page.waitForLoadState(c.state, { timeout: c.timeout_ms });
      return { ok: true, output: { state: c.state } };
    }

    await new Promise((resolve) => setTimeout(resolve, c.ms));
    return { ok: true, output: { waited_ms: c.ms } };
  },
};

export const reload: StepExecutor = {
  name: 'reload',
  schema: z.object({
    wait_until: WaitUntilSchema,
    timeout_ms: z.number().int().positive().max(120_000).optional(),
  }),
  async execute(ctx, config) {
    const c = config as { wait_until: 'load' | 'domcontentloaded' | 'networkidle' | 'commit'; timeout_ms?: number };
    await ctx.page.reload({ waitUntil: c.wait_until, timeout: c.timeout_ms });
    return { ok: true, output: { url: ctx.page.url() } };
  },
};

export const go_back: StepExecutor = {
  name: 'go_back',
  schema: z.object({
    wait_until: WaitUntilSchema,
    timeout_ms: z.number().int().positive().max(120_000).optional(),
  }),
  async execute(ctx, config) {
    const c = config as { wait_until: 'load' | 'domcontentloaded' | 'networkidle' | 'commit'; timeout_ms?: number };
    await ctx.page.goBack({ waitUntil: c.wait_until, timeout: c.timeout_ms });
    return { ok: true, output: { url: ctx.page.url() } };
  },
};
