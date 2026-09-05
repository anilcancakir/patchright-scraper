import { describe, expect, it, vi } from 'vitest';
import {
  CLICK_HOLD_MEAN_MS,
  KEY_HOLD_MEAN_MS,
  click,
  dblclick,
  press,
  sampleHoldMs,
  type,
} from '../../src/steps/input.js';
import { makeCtx, makeLocator, makePage, runStep } from './_helpers.js';

/**
 * How long a key or a mouse button stays down.
 *
 * The cadence work shipped in v0.6.7 sampled the gap BETWEEN keys and left
 * the hold at nothing, because Playwright's `delay` was being read as a
 * gap when it is not one. Measured at
 * `playwright-core/src/server/input.ts` (`b4e7c87`):
 *
 *   async press(progress, key, options) {
 *     await this.down(progress, key);
 *     if (options.delay) await progress.wait(options.delay);
 *     await this.up(progress, key);
 *   }
 *
 * and `type()` calls `press(char, { delay })` per character. So `delay` is
 * the HOLD, and passing none produced the reading taken off the live pool
 * container on 2026-09-05: dwell 1 to 2 ms per key, mousedown to mouseup
 * 0.5 ms.
 *
 * That matters because it is collectable. Arkose's `enhanced_fp` binds
 * `keydown` and `keyup` (and `mousedown` and `mouseup`) as separate
 * millisecond-stamped events, confirmed at code level in
 * `AzureFlow/arkose-fp-docs` and in the author's own demo page, so hold
 * duration is derivable from what it already sends even though the
 * character identity is not.
 *
 * Against Dhakal et al. (CHI 2018, 136M keystrokes, 168,960 participants)
 * a 1 ms hold is roughly five standard deviations below the human mean and
 * outside the observed range entirely.
 */
describe('sampleHoldMs', () => {
  it('centres on the configured mean with a real spread', () => {
    const samples = Array.from({ length: 1000 }, () => sampleHoldMs(KEY_HOLD_MEAN_MS));
    const mean = samples.reduce((sum, v) => sum + v, 0) / samples.length;

    expect(mean).toBeGreaterThanOrEqual(KEY_HOLD_MEAN_MS * 0.9);
    expect(mean).toBeLessThanOrEqual(KEY_HOLD_MEAN_MS * 1.1);
    expect(new Set(samples).size).toBeGreaterThan(20);
  });

  it('is far tighter than the inter-key gap, because hold time is', () => {
    // Dhakal measures hold at 116.25 +- 23.88 ms (CV 0.205) and the
    // inter-key interval at 238.66 +- 111.6 ms (CV 0.47). Reusing the gap
    // sampler's spread here would produce holds of 20 ms and 400 ms, both
    // outside anything that paper saw.
    const samples = Array.from({ length: 2000 }, () => sampleHoldMs(KEY_HOLD_MEAN_MS));
    const mean = samples.reduce((sum, v) => sum + v, 0) / samples.length;
    const sd = Math.sqrt(
      samples.reduce((sum, v) => sum + (v - mean) ** 2, 0) / samples.length,
    );

    expect(sd / mean).toBeLessThan(0.3);
    expect(sd / mean).toBeGreaterThan(0.1);
  });

  it('never returns zero, which is the value being removed', () => {
    const samples = Array.from({ length: 500 }, () => sampleHoldMs(KEY_HOLD_MEAN_MS));

    expect(Math.min(...samples)).toBeGreaterThan(0);
  });
});

describe('key hold on the type step', () => {
  it('holds each key for a sampled duration instead of releasing instantly', async () => {
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

    const holds = page.keyboard.type.mock.calls.map(
      (call) => (call[1] as { delay: number } | undefined)?.delay,
    );

    expect(holds).toHaveLength(4);
    for (const hold of holds) {
      expect(hold).toBeGreaterThan(0);
    }
    // Sampled, not a constant: four identical holds would be its own tell.
    expect(new Set(holds).size).toBeGreaterThan(1);
  });

  it('takes the hold out of the inter-key interval rather than adding to it', async () => {
    // The literature number the recipes are budgeted against (240 ms) is a
    // keydown-to-keydown interval, and the hold sits INSIDE it. Adding the
    // hold on top would stretch every stored recipe past the timeout its
    // author measured, so the gap is what shrinks.
    const locator = makeLocator();
    const page = makePage({ locator: vi.fn(() => locator) as never });
    const { ctx } = makeCtx({ page });

    const startedAt = Date.now();
    await runStep(type, ctx, {
      locator: { selector: '#compose' },
      text: 'abcdefgh',
      delay: 40,
      clear: false,
      timeout: 5_000,
    });
    const elapsed = Date.now() - startedAt;

    // Eight characters at a 40 ms interval is ~320 ms of wall clock. The
    // mock resolves `keyboard.type` immediately, so the hold this step
    // asked Playwright for costs nothing here; what is being pinned is
    // that the step does not ALSO sleep for it.
    expect(elapsed).toBeLessThan(8 * 40 * 3);
  });

  it('keeps the instant path fully instant when a recipe opts out', async () => {
    const locator = makeLocator();
    const page = makePage({ locator: vi.fn(() => locator) as never });
    const { ctx } = makeCtx({ page });

    await runStep(type, ctx, {
      locator: { selector: '#compose' },
      text: 'ab',
      delay: 0,
      clear: false,
      timeout: 5_000,
    });

    expect(locator.pressSequentially).toHaveBeenCalledWith('ab', {
      delay: 0,
      timeout: expect.any(Number),
    });
    expect(page.keyboard.type).not.toHaveBeenCalled();
  });
});

describe('button hold on click, dblclick and press', () => {
  it('click holds the button down for a sampled duration by default', async () => {
    const locator = makeLocator();
    const page = makePage({ locator: vi.fn(() => locator) as never });
    const { ctx } = makeCtx({ page });

    await runStep(click, ctx, { locator: { selector: '.btn' }, timeout: 5_000 });

    const delay = (locator.click.mock.calls[0]?.[0] as { delay: number }).delay;

    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeGreaterThan(CLICK_HOLD_MEAN_MS / 3);
    expect(delay).toBeLessThan(CLICK_HOLD_MEAN_MS * 3);
  });

  it('the click hold is sampled per click, not a constant', async () => {
    const holds = new Set<number>();

    for (let i = 0; i < 12; i++) {
      const locator = makeLocator();
      const page = makePage({ locator: vi.fn(() => locator) as never });
      const { ctx } = makeCtx({ page });

      await runStep(click, ctx, { locator: { selector: '.btn' }, timeout: 5_000 });
      holds.add((locator.click.mock.calls[0]?.[0] as { delay: number }).delay);
    }

    expect(holds.size).toBeGreaterThan(1);
  });

  it('a recipe pinning delay 0 still gets an instant click', async () => {
    const locator = makeLocator();
    const page = makePage({ locator: vi.fn(() => locator) as never });
    const { ctx } = makeCtx({ page });

    await runStep(click, ctx, { locator: { selector: '.btn' }, delay: 0, timeout: 5_000 });

    expect((locator.click.mock.calls[0]?.[0] as { delay: number }).delay).toBe(0);
  });

  it('dblclick holds too', async () => {
    const locator = makeLocator();
    const page = makePage({ locator: vi.fn(() => locator) as never });
    const { ctx } = makeCtx({ page });

    await runStep(dblclick, ctx, { locator: { selector: '.row' }, timeout: 5_000 });

    expect((locator.dblclick.mock.calls[0]?.[0] as { delay: number }).delay).toBeGreaterThan(0);
  });

  it('press holds the key, which is what the X login Enter goes through', async () => {
    // The two `press: Enter` steps in the login recipe were the last
    // zero-hold key events left once the credentials moved to `type`.
    const page = makePage();
    const { ctx } = makeCtx({ page });

    await runStep(press, ctx, { key: 'Enter', timeout: 5_000 });

    expect((page.keyboard.press.mock.calls[0]?.[1] as { delay: number }).delay).toBeGreaterThan(0);
  });

  it('press with an explicit delay 0 stays instant', async () => {
    const page = makePage();
    const { ctx } = makeCtx({ page });

    await runStep(press, ctx, { key: 'Escape', delay: 0, timeout: 5_000 });

    expect((page.keyboard.press.mock.calls[0]?.[1] as { delay: number }).delay).toBe(0);
  });

  it('every stored recipe that pinned delay 0 still parses under .strict()', () => {
    expect(click.schema.safeParse({ locator: { selector: '.b' }, delay: 0 }).success).toBe(true);
    expect(press.schema.safeParse({ key: 'Enter', delay: 0 }).success).toBe(true);
  });
});
