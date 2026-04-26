import { z } from 'zod';
import type { StepExecutor } from './types.js';

export const screenshot: StepExecutor = {
  name: 'screenshot',
  description: 'Capture a viewport, full page, or single-element screenshot.',
  schema: z.object({
    mode: z.enum(['viewport', 'full', 'element']).default('viewport'),
    selector: z.string().optional(),
    encoding: z.enum(['base64', 'binary']).default('base64'),
    timeout_ms: z.number().int().positive().default(30_000),
  }).strict(),
  async execute(ctx, config) {
    const c = config as { mode: 'viewport' | 'full' | 'element'; selector?: string; encoding: 'base64' | 'binary'; timeout_ms: number };

    let buffer: Buffer;
    if (c.mode === 'element') {
      if (c.selector === undefined) {
        return { ok: false, error: 'screenshot: element mode requires selector' };
      }
      const handle = await ctx.page.waitForSelector(c.selector, { timeout: c.timeout_ms });
      if (handle === null) {
        return { ok: false, error: `screenshot: selector not found ${c.selector}` };
      }
      buffer = await handle.screenshot();
    } else {
      buffer = await ctx.page.screenshot({ fullPage: c.mode === 'full', timeout: c.timeout_ms });
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

export const html: StepExecutor = {
  name: 'html',
  description: 'Return the page or element outerHTML.',
  schema: z.object({
    selector: z.string().optional(),
    timeout_ms: z.number().int().positive().default(10_000),
  }).strict(),
  async execute(ctx, config) {
    const c = config as { selector?: string; timeout_ms: number };

    if (c.selector === undefined) {
      const content = await ctx.page.content();
      return { ok: true, output: { html: content } };
    }

    const handle = await ctx.page.waitForSelector(c.selector, { timeout: c.timeout_ms });
    if (handle === null) {
      return { ok: false, error: `html: selector not found ${c.selector}` };
    }

    const outer = await handle.evaluate((el) => (el as Element).outerHTML);
    return { ok: true, output: { html: outer } };
  },
};

export const text: StepExecutor = {
  name: 'text',
  description: 'Return the innerText of an element matched by selector.',
  schema: z.object({
    selector: z.string(),
    timeout_ms: z.number().int().positive().default(10_000),
  }).strict(),
  async execute(ctx, config) {
    const c = config as { selector: string; timeout_ms: number };
    const handle = await ctx.page.waitForSelector(c.selector, { timeout: c.timeout_ms });
    if (handle === null) {
      return { ok: false, error: `text: selector not found ${c.selector}` };
    }
    const value = await handle.innerText();
    return { ok: true, output: { text: value } };
  },
};

export const attribute: StepExecutor = {
  name: 'attribute',
  description: 'Return a single attribute value for an element matched by selector.',
  schema: z.object({
    selector: z.string(),
    name: z.string(),
    timeout_ms: z.number().int().positive().default(10_000),
  }).strict(),
  async execute(ctx, config) {
    const c = config as { selector: string; name: string; timeout_ms: number };
    const handle = await ctx.page.waitForSelector(c.selector, { timeout: c.timeout_ms });
    if (handle === null) {
      return { ok: false, error: `attribute: selector not found ${c.selector}` };
    }
    const value = await handle.getAttribute(c.name);
    return { ok: true, output: { name: c.name, value } };
  },
};

export const evaluate_named: StepExecutor = {
  name: 'evaluate_named',
  description: 'Evaluate a JavaScript expression in the page and store the named result.',
  schema: z.object({
    name: z.string(),
    expression: z.string(),
    args: z.array(z.unknown()).default([]),
  }).strict(),
  async execute(ctx, config) {
    const c = config as { name: string; expression: string; args: unknown[] };
    ctx.log('evaluate_named', { name: c.name });
    // Build a function from the expression string. Patchright passes the
    // function plus args to page.evaluate.
    const result = await ctx.page.evaluate(
      ({ expr, args }) => {
        // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
        const fn = new Function('args', `return (${expr}).apply(null, args);`);
        return fn(args);
      },
      { expr: c.expression, args: c.args },
    );
    return { ok: true, output: { name: c.name, result } };
  },
};

export const extract_dom_named: StepExecutor = {
  name: 'extract_dom_named',
  description: 'Extract attributes and text from every element matching a selector.',
  schema: z.object({
    name: z.string(),
    selector: z.string(),
    attrs: z.array(z.string()).default([]),
    include_text: z.boolean().default(true),
    timeout_ms: z.number().int().positive().default(10_000),
  }).strict(),
  async execute(ctx, config) {
    const c = config as { name: string; selector: string; attrs: string[]; include_text: boolean; timeout_ms: number };

    // Wait for at least one match before scraping the rest. Docs that
    // never render the selector should error rather than silently return [].
    await ctx.page.waitForSelector(c.selector, { timeout: c.timeout_ms });

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
      { selector: c.selector, attrs: c.attrs, includeText: c.include_text },
    );

    return { ok: true, output: { name: c.name, rows } };
  },
};
