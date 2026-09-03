import { describe, expect, it, vi } from 'vitest';
import { KEYSTROKE_MEAN_MS, sampleKeystrokeGap, type } from '../../src/steps/input.js';
import { makeCtx, makeLocator, makePage, runStep } from './_helpers.js';

/**
 * Inter-keystroke timing on the `type` step.
 *
 * Both scraper tiers used to type at machine speed: `delay` defaulted to
 * 0, so a 40-character field arrived as 40 key events with no gap between
 * them. That is a behavioural signal independent of how the event was
 * dispatched, which is the axis the 2026-09-03 CDP-versus-XTEST
 * measurement explicitly could NOT rule out: it held provenance constant
 * and found nothing, leaving timing as the untested variable.
 *
 * A constant gap would be no better than none, because no human types at
 * exactly 100ms intervals, so the gap is sampled per character.
 */

describe('sampleKeystrokeGap', () => {
  it('stays inside a band around the mean', () => {
    const samples = Array.from({ length: 300 }, () => sampleKeystrokeGap(100));

    // 40 per cent either side of a 100ms mean.
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(60);
    expect(Math.max(...samples)).toBeLessThanOrEqual(140);
  });

  it('does not return a constant, which would be its own signal', () => {
    const distinct = new Set(Array.from({ length: 300 }, () => sampleKeystrokeGap(100)));

    expect(distinct.size).toBeGreaterThan(10);
  });

  it('scales with the requested mean', () => {
    const samples = Array.from({ length: 300 }, () => sampleKeystrokeGap(20));

    expect(Math.min(...samples)).toBeGreaterThanOrEqual(12);
    expect(Math.max(...samples)).toBeLessThanOrEqual(28);
  });

  it('treats zero as an explicit opt-out rather than a tiny gap', () => {
    expect(sampleKeystrokeGap(0)).toBe(0);
  });
});

describe('type step timing', () => {
  it('no longer defaults to machine speed', () => {
    const parsed = type.schema.safeParse({ locator: { selector: '#a' }, text: 'hi' });

    expect(parsed.success).toBe(true);
    expect(parsed.success && (parsed.data as { delay: number }).delay).toBe(KEYSTROKE_MEAN_MS);
    expect(KEYSTROKE_MEAN_MS).toBeGreaterThan(0);
  });

  it('sends one key event per character when a gap is in play', async () => {
    const locator = makeLocator();
    const page = makePage({ locator: vi.fn(() => locator) as never });
    const { ctx } = makeCtx({ page });

    await runStep(type, ctx, {
      locator: { selector: '#compose' },
      text: 'abcd',
      delay: 5,
      clear: false,
      timeout: 5_000,
    });

    expect(page.keyboard.type).toHaveBeenCalledTimes(4);
    expect(page.keyboard.type.mock.calls.map((call) => call[0])).toEqual(['a', 'b', 'c', 'd']);
    // The whole-string call is what produced the no-gap burst.
    expect(locator.pressSequentially).not.toHaveBeenCalled();
  });

  it('keeps the instant path when a recipe asks for delay 0', async () => {
    const locator = makeLocator();
    const page = makePage({ locator: vi.fn(() => locator) as never });
    const { ctx } = makeCtx({ page });

    await runStep(type, ctx, {
      locator: { selector: '#compose' },
      text: 'abcd',
      delay: 0,
      clear: false,
      timeout: 5_000,
    });

    expect(locator.pressSequentially).toHaveBeenCalled();
    expect(page.keyboard.type).not.toHaveBeenCalled();
  });

  it('refuses text it cannot finish inside the step budget, naming both levers', async () => {
    const locator = makeLocator();
    const page = makePage({ locator: vi.fn(() => locator) as never });
    const { ctx } = makeCtx({ page });

    // 400 characters at a 100ms mean is 40 seconds of typing. Silently
    // overrunning would hold the browser well past the declared timeout,
    // which is the failure the locator budget work exists to prevent.
    await expect(
      runStep(type, ctx, {
        locator: { selector: '#compose' },
        text: 'x'.repeat(400),
        delay: 100,
        clear: false,
        timeout: 5_000,
      }),
    ).rejects.toThrow(/timeout.*delay|delay.*timeout/i);

    expect(page.keyboard.type).not.toHaveBeenCalled();
  });
});
