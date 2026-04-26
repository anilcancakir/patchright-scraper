import { describe, expect, it } from 'vitest';
import { go_back, goto, reload, wait_for } from '../../src/steps/navigation.js';
import { makeCtx } from './_helpers.js';

describe('navigation primitives', () => {
  it('goto navigates and returns the resolved url + status', async () => {
    const { ctx, page } = makeCtx();
    page.goto.mockResolvedValueOnce({ status: () => 200 });
    page.url.mockReturnValueOnce('https://example.org/landing');

    const result = await goto.execute(ctx, { url: 'https://example.org/landing', wait_until: 'load' });

    expect(page.goto).toHaveBeenCalledWith('https://example.org/landing', expect.objectContaining({ waitUntil: 'load' }));
    expect(result.ok).toBe(true);
    expect((result.output as { url: string }).url).toBe('https://example.org/landing');
  });

  it('wait_for delegates to waitForSelector in selector mode', async () => {
    const { ctx, page } = makeCtx();

    const result = await wait_for.execute(ctx, {
      mode: 'selector',
      selector: 'button#submit',
      state: 'visible',
      timeout_ms: 5_000,
    });

    expect(page.waitForSelector).toHaveBeenCalledWith('button#submit', expect.objectContaining({ state: 'visible' }));
    expect(result.ok).toBe(true);
  });

  it('wait_for sleeps in timeout mode', async () => {
    const { ctx, page } = makeCtx();

    const result = await wait_for.execute(ctx, { mode: 'timeout', ms: 5 });

    expect(page.waitForSelector).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect((result.output as { waited_ms: number }).waited_ms).toBe(5);
  });

  it('reload calls page.reload', async () => {
    const { ctx, page } = makeCtx();

    await reload.execute(ctx, { wait_until: 'networkidle' });

    expect(page.reload).toHaveBeenCalled();
  });

  it('go_back calls page.goBack', async () => {
    const { ctx, page } = makeCtx();

    await go_back.execute(ctx, { wait_until: 'load' });

    expect(page.goBack).toHaveBeenCalled();
  });
});
