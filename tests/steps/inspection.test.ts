import { describe, expect, it, vi } from 'vitest';
import {
  attribute,
  evaluate_named,
  extract_dom_named,
  html,
  screenshot,
  text,
} from '../../src/steps/inspection.js';
import { makeCtx, makeHandle, makePage } from './_helpers.js';

describe('inspection primitives', () => {
  it('screenshot returns base64 by default', async () => {
    const page = makePage({ screenshot: vi.fn(async () => Buffer.from('PNG-DATA')) });
    const { ctx } = makeCtx({ page });

    const result = await screenshot.execute(ctx, { mode: 'viewport', encoding: 'base64', timeout_ms: 5_000 });

    expect(result.ok).toBe(true);
    expect(result.screenshot).toBe(Buffer.from('PNG-DATA').toString('base64'));
    expect((result.output as { bytes: number }).bytes).toBe(8);
  });

  it('screenshot in element mode requires a selector', async () => {
    const { ctx } = makeCtx();

    const result = await screenshot.execute(ctx, { mode: 'element', encoding: 'base64', timeout_ms: 5_000 });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/requires selector/);
  });

  it('html returns full document when no selector', async () => {
    const page = makePage({ content: vi.fn(async () => '<html><body>hi</body></html>') });
    const { ctx } = makeCtx({ page });

    const result = await html.execute(ctx, { timeout_ms: 5_000 });

    expect(result.ok).toBe(true);
    expect((result.output as { html: string }).html).toContain('hi');
  });

  it('text returns innerText of the matched element', async () => {
    const handle = makeHandle({ innerText: vi.fn(async () => 'Welcome') });
    const page = makePage({ waitForSelector: vi.fn(async () => handle as never) });
    const { ctx } = makeCtx({ page });

    const result = await text.execute(ctx, { selector: 'h1', timeout_ms: 5_000 });

    expect(result.ok).toBe(true);
    expect((result.output as { text: string }).text).toBe('Welcome');
  });

  it('attribute returns getAttribute value', async () => {
    const handle = makeHandle({ getAttribute: vi.fn(async () => 'submit') });
    const page = makePage({ waitForSelector: vi.fn(async () => handle as never) });
    const { ctx } = makeCtx({ page });

    const result = await attribute.execute(ctx, { selector: 'button', name: 'type', timeout_ms: 5_000 });

    expect(result.ok).toBe(true);
    expect((result.output as { value: string }).value).toBe('submit');
  });

  it('evaluate_named runs the expression via page.evaluate', async () => {
    const evaluate = vi.fn(async () => 42);
    const page = makePage({ evaluate: evaluate as never });
    const { ctx } = makeCtx({ page });

    const result = await evaluate_named.execute(ctx, { name: 'sum', expression: 'function(a,b){return a+b}', args: [1, 2] });

    expect(result.ok).toBe(true);
    expect(evaluate).toHaveBeenCalled();
    expect((result.output as { result: number }).result).toBe(42);
  });

  it('extract_dom_named returns mapped rows', async () => {
    const evaluate = vi.fn(async () => [{ href: '/a', text: 'A' }, { href: '/b', text: 'B' }]);
    const page = makePage({
      waitForSelector: vi.fn(async () => makeHandle() as never),
      evaluate: evaluate as never,
    });
    const { ctx } = makeCtx({ page });

    const result = await extract_dom_named.execute(ctx, {
      name: 'links',
      selector: 'a',
      attrs: ['href'],
      include_text: true,
      timeout_ms: 5_000,
    });

    expect(result.ok).toBe(true);
    const rows = (result.output as { rows: Array<{ href: string }> }).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.href).toBe('/a');
  });
});
