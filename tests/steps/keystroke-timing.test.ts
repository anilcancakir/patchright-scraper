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
  it('does not return a constant, which would be its own signal', () => {
    const distinct = new Set(Array.from({ length: 300 }, () => sampleKeystrokeGap(100)));

    expect(distinct.size).toBeGreaterThan(10);
  });

  it('treats zero as an explicit opt-out rather than a tiny gap', () => {
    expect(sampleKeystrokeGap(0)).toBe(0);
  });

  it('averages near the configured mean but has a real right tail, not a clamped band', () => {
    // A uniform, hard-clamped draw (the v0.6.2 implementation this step
    // replaces) structurally cannot satisfy the second assertion: its
    // maximum is bounded at mean * (1 + jitter), which never reaches 2x
    // the mean. Gonzalez et al. (PMC8606350) found real inter-key timing
    // heavy-tailed and right-skewed against 14 candidate distributions,
    // with log-normal a close second to log-logistic; this is the
    // reproducer for that shape, and it is the red phase for this step.
    const mean = 240;
    const samples = Array.from({ length: 1000 }, () => sampleKeystrokeGap(mean));
    const sampleMean = samples.reduce((sum, v) => sum + v, 0) / samples.length;

    expect(sampleMean).toBeGreaterThanOrEqual(mean * 0.85);
    expect(sampleMean).toBeLessThanOrEqual(mean * 1.15);
    expect(Math.max(...samples)).toBeGreaterThan(mean * 2);
  });

  it('is right-skewed: the median sits below the mean', () => {
    const mean = 240;
    const samples = Array.from({ length: 1000 }, () => sampleKeystrokeGap(mean));
    const sampleMean = samples.reduce((sum, v) => sum + v, 0) / samples.length;
    const sorted = [...samples].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const left = sorted[mid - 1];
    const right = sorted[mid];
    if (left === undefined || right === undefined) {
      throw new Error('sample array unexpectedly short for median lookup');
    }
    const median = (left + right) / 2;

    expect(median).toBeLessThan(sampleMean);
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

  it('bites sooner at the raised default mean, still naming both levers', async () => {
    const locator = makeLocator();
    const page = makePage({ locator: vi.fn(() => locator) as never });
    const { ctx } = makeCtx({ page });

    // No `delay` given, so the schema default (KEYSTROKE_MEAN_MS) applies.
    // 50 characters at 240ms is 12,000ms against a 10,000ms budget: the
    // same guard as above, but exercised through the raised default
    // rather than an explicit delay, per this step's Done-when.
    await expect(
      runStep(type, ctx, {
        locator: { selector: '#compose' },
        text: 'x'.repeat(50),
        clear: false,
        timeout: 10_000,
      }),
    ).rejects.toThrow(/timeout.*delay|delay.*timeout/i);

    expect(page.keyboard.type).not.toHaveBeenCalled();
  });
});
