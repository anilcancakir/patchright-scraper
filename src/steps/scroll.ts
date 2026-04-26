import { z } from 'zod';
import type { StepExecutor } from './types.js';

const TimeoutMs = z.number().int().positive().max(120_000);

export const scrollBy: StepExecutor = {
  name: 'scrollBy',
  description: 'Scroll the page by a pixel offset.',
  schema: z
    .object({
      x: z.number().default(0),
      y: z.number().default(0),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as { x: number; y: number };
    await ctx.page.evaluate(({ x, y }) => window.scrollBy(x, y), { x: c.x, y: c.y });

    return { ok: true, output: { x: c.x, y: c.y } };
  },
};

export const scrollUntilPlateau: StepExecutor = {
  name: 'scrollUntilPlateau',
  description: 'Scroll repeatedly until the page or container height stops growing.',
  schema: z
    .object({
      selector: z.string().optional(),
      maxIterations: z.number().int().positive().default(20),
      settleMs: z.number().int().nonnegative().default(750),
      plateauIterations: z.number().int().positive().default(2),
      stepPx: z.number().int().positive().default(1200),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as {
      selector?: string;
      maxIterations: number;
      settleMs: number;
      plateauIterations: number;
      stepPx: number;
    };

    let lastHeight = -1;
    let plateauHits = 0;
    let iterations = 0;

    for (; iterations < c.maxIterations; iterations++) {
      const height = await ctx.page.evaluate(
        ({ selector, stepPx }) => {
          const target = selector
            ? (document.querySelector(selector) as HTMLElement | null)
            : null;

          if (target) {
            target.scrollBy({ top: stepPx });
            return target.scrollHeight;
          }

          window.scrollBy({ top: stepPx });
          return document.documentElement.scrollHeight;
        },
        { selector: c.selector, stepPx: c.stepPx },
      );

      await new Promise((resolve) => setTimeout(resolve, c.settleMs));

      if (height === lastHeight) {
        plateauHits += 1;
        if (plateauHits >= c.plateauIterations) {
          return {
            ok: true,
            output: { iterations: iterations + 1, finalHeight: height, plateau: true },
          };
        }
      } else {
        plateauHits = 0;
        lastHeight = height;
      }
    }

    return { ok: true, output: { iterations, finalHeight: lastHeight, plateau: false } };
  },
};

export const scrollModal: StepExecutor = {
  name: 'scrollModal',
  description: 'Scroll inside a modal until its inner content stops growing.',
  schema: z
    .object({
      modalSelector: z.string().min(1),
      scrollSelector: z.string().optional(),
      maxIterations: z.number().int().positive().default(15),
      settleMs: z.number().int().nonnegative().default(500),
      stepPx: z.number().int().positive().default(800),
      timeout: TimeoutMs.default(10_000),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as {
      modalSelector: string;
      scrollSelector?: string;
      maxIterations: number;
      settleMs: number;
      stepPx: number;
      timeout: number;
    };

    await ctx.page.waitForSelector(c.modalSelector, { timeout: c.timeout });

    const target = c.scrollSelector ?? c.modalSelector;
    let lastHeight = -1;

    for (let i = 0; i < c.maxIterations; i++) {
      const height = await ctx.page.evaluate(
        ({ selector, stepPx }) => {
          const el = document.querySelector(selector) as HTMLElement | null;
          if (el === null) return -1;
          el.scrollBy({ top: stepPx });
          return el.scrollHeight;
        },
        { selector: target, stepPx: c.stepPx },
      );

      await new Promise((resolve) => setTimeout(resolve, c.settleMs));

      if (height === -1) {
        return { ok: false, error: `scrollModal: selector lost ${target}` };
      }

      if (height === lastHeight) {
        return { ok: true, output: { iterations: i + 1, finalHeight: height, plateau: true } };
      }
      lastHeight = height;
    }

    return {
      ok: true,
      output: { iterations: c.maxIterations, finalHeight: lastHeight, plateau: false },
    };
  },
};
