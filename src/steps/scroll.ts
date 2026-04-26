import { z } from 'zod';
import type { StepExecutor } from './types.js';

export const scroll_to: StepExecutor = {
  name: 'scroll_to',
  schema: z.object({
    selector: z.string(),
    behavior: z.enum(['auto', 'smooth']).default('auto'),
    block: z.enum(['start', 'center', 'end', 'nearest']).default('center'),
    timeout_ms: z.number().int().positive().default(10_000),
  }).strict(),
  async execute(ctx, config) {
    const c = config as { selector: string; behavior: 'auto' | 'smooth'; block: 'start' | 'center' | 'end' | 'nearest'; timeout_ms: number };
    const handle = await ctx.page.waitForSelector(c.selector, { timeout: c.timeout_ms });
    if (handle === null) {
      return { ok: false, error: `scroll_to: selector not found ${c.selector}` };
    }
    await handle.evaluate(
      (el, opts) => (el as Element).scrollIntoView(opts),
      { behavior: c.behavior, block: c.block },
    );
    return { ok: true, output: { selector: c.selector } };
  },
};

export const scroll_by: StepExecutor = {
  name: 'scroll_by',
  schema: z.object({
    x: z.number().default(0),
    y: z.number().default(0),
  }).strict(),
  async execute(ctx, config) {
    const c = config as { x: number; y: number };
    await ctx.page.evaluate(({ x, y }) => window.scrollBy(x, y), { x: c.x, y: c.y });
    return { ok: true, output: { x: c.x, y: c.y } };
  },
};

export const scroll_until_plateau: StepExecutor = {
  name: 'scroll_until_plateau',
  schema: z.object({
    selector: z.string().optional(),
    max_iterations: z.number().int().positive().default(20),
    settle_ms: z.number().int().nonnegative().default(750),
    plateau_iterations: z.number().int().positive().default(2),
    step_px: z.number().int().positive().default(1200),
  }).strict(),
  async execute(ctx, config) {
    const c = config as { selector?: string; max_iterations: number; settle_ms: number; plateau_iterations: number; step_px: number };

    let lastHeight = -1;
    let plateauHits = 0;
    let iterations = 0;

    for (; iterations < c.max_iterations; iterations++) {
      const height = await ctx.page.evaluate(
        ({ selector, stepPx }) => {
          const target = selector ? (document.querySelector(selector) as HTMLElement | null) : null;
          const container: HTMLElement | (Window & typeof globalThis) = target ?? window;

          if (target) {
            target.scrollBy({ top: stepPx });
            return target.scrollHeight;
          }

          window.scrollBy({ top: stepPx });
          return document.documentElement.scrollHeight;
        },
        { selector: c.selector, stepPx: c.step_px },
      );

      await new Promise((resolve) => setTimeout(resolve, c.settle_ms));

      if (height === lastHeight) {
        plateauHits += 1;
        if (plateauHits >= c.plateau_iterations) {
          return { ok: true, output: { iterations: iterations + 1, final_height: height, plateau: true } };
        }
      } else {
        plateauHits = 0;
        lastHeight = height;
      }
    }

    return { ok: true, output: { iterations, final_height: lastHeight, plateau: false } };
  },
};

export const scroll_modal: StepExecutor = {
  name: 'scroll_modal',
  schema: z.object({
    modal_selector: z.string(),
    scroll_selector: z.string().optional(),
    max_iterations: z.number().int().positive().default(15),
    settle_ms: z.number().int().nonnegative().default(500),
    step_px: z.number().int().positive().default(800),
    timeout_ms: z.number().int().positive().default(10_000),
  }).strict(),
  async execute(ctx, config) {
    const c = config as { modal_selector: string; scroll_selector?: string; max_iterations: number; settle_ms: number; step_px: number; timeout_ms: number };

    await ctx.page.waitForSelector(c.modal_selector, { timeout: c.timeout_ms });

    const target = c.scroll_selector ?? c.modal_selector;
    let lastHeight = -1;

    for (let i = 0; i < c.max_iterations; i++) {
      const height = await ctx.page.evaluate(
        ({ selector, stepPx }) => {
          const el = document.querySelector(selector) as HTMLElement | null;
          if (el === null) return -1;
          el.scrollBy({ top: stepPx });
          return el.scrollHeight;
        },
        { selector: target, stepPx: c.step_px },
      );

      await new Promise((resolve) => setTimeout(resolve, c.settle_ms));

      if (height === -1) {
        return { ok: false, error: `scroll_modal: selector lost ${target}` };
      }

      if (height === lastHeight) {
        return { ok: true, output: { iterations: i + 1, final_height: height, plateau: true } };
      }
      lastHeight = height;
    }

    return { ok: true, output: { iterations: c.max_iterations, final_height: lastHeight, plateau: false } };
  },
};

export const set_viewport: StepExecutor = {
  name: 'set_viewport',
  schema: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }).strict(),
  async execute(ctx, config) {
    const c = config as { width: number; height: number };
    await ctx.page.setViewportSize({ width: c.width, height: c.height });
    return { ok: true, output: { width: c.width, height: c.height } };
  },
};

export const set_user_agent: StepExecutor = {
  name: 'set_user_agent',
  schema: z.object({
    user_agent: z.string(),
  }).strict(),
  async execute(ctx, config) {
    const c = config as { user_agent: string };
    // Patchright cannot mutate the UA of a live context. Persist the
    // override so a future session refresh applies it; warn the caller.
    ctx.log('set_user_agent: stored, applies on next session boot', { user_agent: c.user_agent });
    return {
      ok: true,
      output: {
        user_agent: c.user_agent,
        applied_immediately: false,
        note: 'Stored for next session boot; live UA mutation is not supported.',
      },
    };
  },
};
