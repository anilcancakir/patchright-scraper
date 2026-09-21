import { describe, expect as assert, it, vi } from 'vitest';
import { expect } from '../../src/steps/expect.js';
import { makeCtx, makeLocator, makePage, runStep } from './_helpers.js';

/**
 * `expect` polls, and a poll swallows the throws of a locator that is not
 * there yet. It used to swallow a dead browser the same way, so the step
 * spent its whole timeout and answered "timed out" with a 200, and the
 * caller could not tell a disabled button from a browser that was gone.
 */
describe('expect against a browser that is gone', () => {
  it('ends with the browser error instead of polling to its timeout', async () => {
    const locator = makeLocator({
      isEnabled: vi.fn(async () => {
        throw new Error('locator.isEnabled: Target page, context or browser has been closed');
      }),
    });
    const { ctx } = makeCtx({ page: makePage({ locator: vi.fn(() => locator) }) });

    const started = Date.now();

    await assert(
      runStep(expect, ctx, { assertion: 'toBeEnabled', locator: { selector: 'button' }, timeout: 5_000 }),
    ).rejects.toThrow(/has been closed/);

    assert(Date.now() - started).toBeLessThan(1_000);
  });

  it('still polls through a locator that is merely not there yet', async () => {
    const isEnabled = vi.fn()
      .mockRejectedValueOnce(new Error('locator.isEnabled: element is not attached'))
      .mockResolvedValue(true);
    const locator = makeLocator({ isEnabled });
    const { ctx } = makeCtx({ page: makePage({ locator: vi.fn(() => locator) }) });

    const result = await runStep(expect, ctx, {
      assertion: 'toBeEnabled',
      locator: { selector: 'button' },
      timeout: 5_000,
    });

    assert(result.ok).toBe(true);
  });
});
