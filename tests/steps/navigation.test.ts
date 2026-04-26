import { describe, expect, it } from 'vitest';
import { goBack, goForward, goto, reload } from '../../src/steps/navigation.js';
import { makeCtx } from './_helpers.js';

describe('navigation primitives', () => {
  it('goto navigates and returns the resolved url + status', async () => {
    const { ctx, page } = makeCtx();
    page.goto.mockResolvedValueOnce({ status: () => 200 });
    page.url.mockReturnValueOnce('https://example.org/landing');

    const result = await goto.execute(ctx, {
      url: 'https://example.org/landing',
      waitUntil: 'load',
    });

    expect(page.goto).toHaveBeenCalledWith(
      'https://example.org/landing',
      expect.objectContaining({ waitUntil: 'load' }),
    );
    expect(result.ok).toBe(true);
    expect((result.output as { url: string }).url).toBe('https://example.org/landing');
  });

  it('reload calls page.reload', async () => {
    const { ctx, page } = makeCtx();

    await reload.execute(ctx, { waitUntil: 'networkidle' });

    expect(page.reload).toHaveBeenCalled();
  });

  it('goBack calls page.goBack', async () => {
    const { ctx, page } = makeCtx();

    await goBack.execute(ctx, { waitUntil: 'load' });

    expect(page.goBack).toHaveBeenCalled();
  });

  it('goForward calls page.goForward', async () => {
    const { ctx, page } = makeCtx();

    await goForward.execute(ctx, { waitUntil: 'load' });

    expect(page.goForward).toHaveBeenCalled();
  });
});
