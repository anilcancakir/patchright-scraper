import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_POINTER_STEPS, click, dblclick, hover } from '../../src/steps/input.js';
import { makeCtx, makeLocator, makePage, runStep } from './_helpers.js';

/**
 * Pointer path on `click`, `dblclick` and `hover`.
 *
 * Playwright's own `click()` moves the pointer first, but `move(x, y,
 * { steps = 1 })` defaults to a single interpolation point
 * (playwright-core `input.ts:216-290`), so what ships is one teleport
 * `mousemove` at the destination rather than a path. Plesner et al.
 * (COMPSAC 2024, arXiv:2409.08831), live against reCAPTCHAv2: no movement
 * averaged 19.23 challenges, straight-line ~7, Bezier 8.38 (t = 0.58,
 * p = 0.57, not significant). Movement is what matters and shape is not
 * measurably better, so these steps draw a straight interpolated line and
 * nothing curved.
 *
 * These assert on the `steps` option handed to `mouse.move` rather than on
 * a count of `mouse.move` calls, and the distinction is the whole point.
 * Playwright interpolates inside its own driver, so one call carrying
 * `{ steps: 12 }` is twelve `mousemove` events in the browser and exactly
 * one call at this layer. Counting calls would have measured a
 * browser-level property with a JS-level instrument, and the only
 * implementation that satisfies a call-count assertion is a hand-rolled
 * loop starting from a point inside the target: more events, worse shape.
 */
const CENTRE_X = 50;
const CENTRE_Y = 20;
const SETTLE_DRIFT_LIMIT_PX = 3;

describe('pointer path on click/dblclick/hover', () => {
  it('click approaches the centre with interpolation, then settles on it, before clicking', async () => {
    const locator = makeLocator();
    const page = makePage({ getByTestId: vi.fn(() => locator) as never });
    const { ctx } = makeCtx({ page });

    await runStep(click, ctx, {
      locator: { testid: 'cta' },
      timeout: 5_000,
    });

    // Approach: one call, interpolated by Playwright from the pointer's
    // last position, which is what makes the path cross the viewport.
    expect(page.mouse.move).toHaveBeenNthCalledWith(1, CENTRE_X, CENTRE_Y, {
      steps: DEFAULT_POINTER_STEPS,
    });
    // Settle: a small drift off the centre, then back onto it.
    expect(page.mouse.move.mock.calls).toHaveLength(3);
    expect(page.mouse.move).toHaveBeenNthCalledWith(3, CENTRE_X, CENTRE_Y);
    expect(locator.click).toHaveBeenCalled();
    // Every move must land before the click, not after or interleaved.
    const lastMoveOrder = page.mouse.move.mock.invocationCallOrder.at(-1) ?? 0;
    const clickOrder = locator.click.mock.invocationCallOrder[0] ?? 0;
    expect(lastMoveOrder).toBeLessThan(clickOrder);
  });

  it('the settle hop drifts off the centre by a few pixels and does not repeat it', async () => {
    const locator = makeLocator();
    const page = makePage({ locator: vi.fn(() => locator) as never });
    const { ctx } = makeCtx({ page });

    await runStep(click, ctx, { locator: { selector: '.btn' }, timeout: 5_000 });

    const settle = page.mouse.move.mock.calls[1] ?? [];
    const driftX = (settle[0] as number) - CENTRE_X;
    const driftY = (settle[1] as number) - CENTRE_Y;

    expect(Math.abs(driftX)).toBeGreaterThanOrEqual(1);
    expect(Math.abs(driftX)).toBeLessThanOrEqual(SETTLE_DRIFT_LIMIT_PX);
    expect(Math.abs(driftY)).toBeGreaterThanOrEqual(1);
    expect(Math.abs(driftY)).toBeLessThanOrEqual(SETTLE_DRIFT_LIMIT_PX);
    // The settle carries no steps option; it is one hop, not a second approach.
    expect(settle[2]).toBeUndefined();
  });

  it('dblclick approaches the centre with interpolation before double-clicking', async () => {
    const locator = makeLocator();
    const page = makePage({ locator: vi.fn(() => locator) as never });
    const { ctx } = makeCtx({ page });

    await runStep(dblclick, ctx, {
      locator: { selector: '.row' },
      timeout: 5_000,
    });

    expect(page.mouse.move).toHaveBeenNthCalledWith(1, CENTRE_X, CENTRE_Y, {
      steps: DEFAULT_POINTER_STEPS,
    });
    expect(locator.dblclick).toHaveBeenCalled();
  });

  it('hover approaches the centre with interpolation before hovering', async () => {
    const locator = makeLocator();
    const page = makePage({ locator: vi.fn(() => locator) as never });
    const { ctx } = makeCtx({ page });

    await runStep(hover, ctx, {
      locator: { selector: '.card' },
      timeout: 5_000,
    });

    expect(page.mouse.move).toHaveBeenNthCalledWith(1, CENTRE_X, CENTRE_Y, {
      steps: DEFAULT_POINTER_STEPS,
    });
    expect(locator.hover).toHaveBeenCalled();
  });

  it('applies the default pointerSteps when a recipe omits it', async () => {
    const locator = makeLocator();
    const page = makePage({ locator: vi.fn(() => locator) as never });
    const { ctx } = makeCtx({ page });

    await runStep(click, ctx, {
      locator: { selector: '.btn' },
      timeout: 5_000,
    });

    expect(page.mouse.move.mock.calls[0]?.[2]).toEqual({ steps: DEFAULT_POINTER_STEPS });
    expect(DEFAULT_POINTER_STEPS).toBeGreaterThan(1);
  });

  it('honours an explicit pointerSteps override', async () => {
    const locator = makeLocator();
    const page = makePage({ locator: vi.fn(() => locator) as never });
    const { ctx } = makeCtx({ page });

    await runStep(click, ctx, {
      locator: { selector: '.btn' },
      pointerSteps: 3,
      timeout: 5_000,
    });

    expect(page.mouse.move.mock.calls[0]?.[2]).toEqual({ steps: 3 });
  });

  it('does not move the pointer when the element has no bounding box (detached)', async () => {
    const locator = makeLocator({ boundingBox: vi.fn(async () => null) });
    const page = makePage({ locator: vi.fn(() => locator) as never });
    const { ctx } = makeCtx({ page });

    await runStep(click, ctx, {
      locator: { selector: '.gone' },
      timeout: 5_000,
    });

    expect(page.mouse.move).not.toHaveBeenCalled();
    // A detached box does not abort the click; Playwright's own action
    // wait/retry is left to decide whether it still lands.
    expect(locator.click).toHaveBeenCalled();
  });

  it('a stored recipe with no pointerSteps still parses under .strict()', () => {
    const parsed = click.schema.safeParse({
      locator: { testid: 'cta' },
      button: 'left',
      clickCount: 1,
      delay: 0,
      force: false,
      timeout: 5_000,
    });

    expect(parsed.success).toBe(true);
  });
});
