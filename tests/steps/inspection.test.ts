import { describe, expect, it, vi } from 'vitest';
import {
  content,
  evaluate,
  extractDom,
  getAttribute,
  innerText,
  inputValue,
  screenshot,
} from '../../src/steps/inspection.js';
import { makeCtx, makeLocator, makePage } from './_helpers.js';

describe('inspection primitives (Playwright shape)', () => {
  it('screenshot returns base64 by default', async () => {
    const page = makePage({ screenshot: vi.fn(async () => Buffer.from('PNG-DATA')) });
    const { ctx } = makeCtx({ page });

    const result = await screenshot.execute(ctx, {
      mode: 'viewport',
      encoding: 'base64',
      timeout: 5_000,
    });

    expect(result.ok).toBe(true);
    expect(result.screenshot).toBe(Buffer.from('PNG-DATA').toString('base64'));
    expect((result.output as { bytes: number }).bytes).toBe(8);
  });

  it('screenshot in element mode requires a locator', async () => {
    const { ctx } = makeCtx();

    const result = await screenshot.execute(ctx, {
      mode: 'element',
      encoding: 'base64',
      timeout: 5_000,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/requires a locator/);
  });

  it('content returns full document when no locator', async () => {
    const page = makePage({ content: vi.fn(async () => '<html><body>hi</body></html>') });
    const { ctx } = makeCtx({ page });

    const result = await content.execute(ctx, { timeout: 5_000 });

    expect(result.ok).toBe(true);
    expect((result.output as { html: string }).html).toContain('hi');
  });

  it('innerText returns the locator innerText', async () => {
    const locator = makeLocator({ innerText: vi.fn(async () => 'Welcome') });
    const page = makePage({ locator: vi.fn(() => locator) as never });
    const { ctx } = makeCtx({ page });

    const result = await innerText.execute(ctx, {
      locator: { selector: 'h1' },
      timeout: 5_000,
    });

    expect(result.ok).toBe(true);
    expect((result.output as { text: string }).text).toBe('Welcome');
  });

  it('getAttribute reads the attribute via locator.getAttribute', async () => {
    const locator = makeLocator({ getAttribute: vi.fn(async () => 'submit') });
    const page = makePage({ locator: vi.fn(() => locator) as never });
    const { ctx } = makeCtx({ page });

    const result = await getAttribute.execute(ctx, {
      locator: { selector: 'button' },
      name: 'type',
      timeout: 5_000,
    });

    expect(result.ok).toBe(true);
    expect((result.output as { value: string }).value).toBe('submit');
  });

  it('inputValue returns the input value', async () => {
    const locator = makeLocator({ inputValue: vi.fn(async () => 'foo@bar') });
    const page = makePage({ getByTestId: vi.fn(() => locator) as never });
    const { ctx } = makeCtx({ page });

    const result = await inputValue.execute(ctx, {
      locator: { testid: 'email' },
      timeout: 5_000,
    });

    expect((result.output as { value: string }).value).toBe('foo@bar');
  });

  it('evaluate runs the expression via page.evaluate', async () => {
    const evalSpy = vi.fn(async () => 42);
    const page = makePage({ evaluate: evalSpy as never });
    const { ctx } = makeCtx({ page });

    const result = await evaluate.execute(ctx, {
      expression: 'function(a,b){return a+b}',
      args: [1, 2],
    });

    expect(result.ok).toBe(true);
    expect(evalSpy).toHaveBeenCalled();
    expect((result.output as { result: number }).result).toBe(42);
  });

  it('extractDom returns mapped rows', async () => {
    const evalSpy = vi.fn(async () => [
      { href: '/a', text: 'A' },
      { href: '/b', text: 'B' },
    ]);
    const page = makePage({
      waitForSelector: vi.fn(async () => makeLocator() as never),
      evaluate: evalSpy as never,
    });
    const { ctx } = makeCtx({ page });

    const result = await extractDom.execute(ctx, {
      name: 'links',
      selector: 'a',
      attrs: ['href'],
      includeText: true,
      timeout: 5_000,
    });

    expect(result.ok).toBe(true);
    const rows = (result.output as { rows: Array<{ href: string }> }).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.href).toBe('/a');
  });
});
