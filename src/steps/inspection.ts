import { z } from 'zod';
import { LocatorSpec, resolveLocator } from './locator.js';
import type { StepExecutor } from './types.js';

const TimeoutMs = z.number().int().positive().max(120_000);

export const screenshot: StepExecutor = {
  name: 'screenshot',
  description: 'Capture a viewport, full-page, or element screenshot.',
  schema: z
    .object({
      mode: z.enum(['viewport', 'full', 'element']).default('viewport'),
      locator: LocatorSpec.optional(),
      encoding: z.enum(['base64', 'binary']).default('base64'),
      timeout: TimeoutMs.default(30_000),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as {
      mode: 'viewport' | 'full' | 'element';
      locator?: LocatorSpec;
      encoding: 'base64' | 'binary';
      timeout: number;
    };

    let buffer: Buffer;
    if (c.mode === 'element') {
      if (c.locator === undefined) {
        return { ok: false, error: 'screenshot: element mode requires a locator' };
      }
      buffer = await resolveLocator(ctx.page, c.locator).screenshot({ timeout: c.timeout });
    } else {
      buffer = await ctx.page.screenshot({ fullPage: c.mode === 'full', timeout: c.timeout });
    }

    const base64 = buffer.toString('base64');

    return {
      ok: true,
      output: {
        bytes: buffer.byteLength,
        encoding: c.encoding,
        ...(c.encoding === 'base64' ? { data: base64 } : {}),
      },
      screenshot: c.encoding === 'base64' ? base64 : undefined,
    };
  },
};

export const content: StepExecutor = {
  name: 'content',
  description: 'Return the page or locator outerHTML.',
  schema: z
    .object({
      locator: LocatorSpec.optional(),
      timeout: TimeoutMs.default(10_000),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as { locator?: LocatorSpec; timeout: number };

    if (c.locator === undefined) {
      const html = await ctx.page.content();
      return { ok: true, output: { html } };
    }

    const handle = resolveLocator(ctx.page, c.locator);
    await handle.waitFor({ state: 'attached', timeout: c.timeout });
    const html = await handle.evaluate((el) => (el as Element).outerHTML);

    return { ok: true, output: { html } };
  },
};

export const innerText: StepExecutor = {
  name: 'innerText',
  description: 'Return the innerText of an element matched by a locator.',
  schema: z
    .object({
      locator: LocatorSpec,
      timeout: TimeoutMs.default(10_000),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as { locator: LocatorSpec; timeout: number };
    const text = await resolveLocator(ctx.page, c.locator).innerText({ timeout: c.timeout });

    return { ok: true, output: { text } };
  },
};

export const getAttribute: StepExecutor = {
  name: 'getAttribute',
  description: 'Return a single attribute value for an element matched by a locator.',
  schema: z
    .object({
      locator: LocatorSpec,
      name: z.string().min(1),
      timeout: TimeoutMs.default(10_000),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as { locator: LocatorSpec; name: string; timeout: number };
    const value = await resolveLocator(ctx.page, c.locator).getAttribute(c.name, {
      timeout: c.timeout,
    });

    return { ok: true, output: { name: c.name, value } };
  },
};

export const inputValue: StepExecutor = {
  name: 'inputValue',
  description: 'Return the current value of an <input>, <textarea>, or <select> element.',
  schema: z
    .object({
      locator: LocatorSpec,
      timeout: TimeoutMs.default(10_000),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as { locator: LocatorSpec; timeout: number };
    const value = await resolveLocator(ctx.page, c.locator).inputValue({ timeout: c.timeout });

    return { ok: true, output: { value } };
  },
};

export const evaluate: StepExecutor = {
  name: 'evaluate',
  description: 'Evaluate a JS expression in the page; result optionally stored under a name.',
  schema: z
    .object({
      expression: z.string().min(1),
      args: z.array(z.unknown()).default([]),
      name: z.string().optional(),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as { expression: string; args: unknown[]; name?: string };

    const result = await ctx.page.evaluate(
      ({ expr, args }) => {
        // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
        const fn = new Function('args', `return (${expr}).apply(null, args);`);
        return fn(args);
      },
      { expr: c.expression, args: c.args },
    );

    return {
      ok: true,
      output: c.name ? { name: c.name, result } : { result },
    };
  },
};

export const extractDom: StepExecutor = {
  name: 'extractDom',
  description: 'Bulk-extract attributes and text for every element matching a selector.',
  schema: z
    .object({
      name: z.string().min(1),
      selector: z.string().min(1),
      attrs: z.array(z.string()).default([]),
      includeText: z.boolean().default(true),
      timeout: TimeoutMs.default(10_000),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as {
      name: string;
      selector: string;
      attrs: string[];
      includeText: boolean;
      timeout: number;
    };

    await ctx.page.waitForSelector(c.selector, { timeout: c.timeout });

    const rows = await ctx.page.evaluate(
      ({ selector, attrs, includeText }) => {
        const elements = Array.from(document.querySelectorAll(selector));
        return elements.map((el) => {
          const row: Record<string, string | null> = {};
          for (const attr of attrs) {
            row[attr] = el.getAttribute(attr);
          }
          if (includeText) {
            row.text = (el as HTMLElement).innerText ?? null;
          }
          return row;
        });
      },
      { selector: c.selector, attrs: c.attrs, includeText: c.includeText },
    );

    return { ok: true, output: { name: c.name, rows } };
  },
};
