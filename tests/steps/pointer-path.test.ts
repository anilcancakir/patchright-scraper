import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_POINTER_STEPS,
  POINTER_MAX_STEP_PX,
  click,
  dblclick,
  hover,
} from '../../src/steps/input.js';
import { makeCtx, makeLocator, makePage, runStep } from './_helpers.js';

/**
 * Pointer path on `click`, `dblclick` and `hover`.
 *
 * Playwright's own `click()` moves the pointer first, but `move(x, y,
 * { steps = 1 })` interpolates a single point, so what ships without help
 * is one teleport `mousemove` at the destination. Plesner et al.
 * (COMPSAC 2024, arXiv:2409.08831), live against reCAPTCHAv2: no movement
 * averaged 19.23 challenges, straight-line ~7, Bezier 8.38 (t = 0.58,
 * p = 0.57, not significant). Movement is what matters and curve shape is
 * not measurably better, so the macro path stays a straight line;
 * BeCAPTCHA-Mouse (arXiv:2005.00890) and DMTG (arXiv:2410.18233) classify
 * Bezier-family synthetic trajectories as non-human at 88 to 99.9 per
 * cent, so a curve generator would trade an unmeasured benefit for a
 * measured tell.
 *
 * What these tests assert is the thing the first implementation got wrong.
 * It delegated interpolation to Playwright's own `steps` option, which
 * divides the line into EQUAL parts, and a live measurement inside the
 * production container (2026-09-05) read the result back off a real page:
 *
 *   dx = [50,50,50,50,50,50,50,50,50,50,50]   every frame, exactly
 *
 * Constant displacement per frame is constant velocity, and a hand
 * accelerates and decelerates. The same measurement also settled what is
 * NOT worth fixing: chrome delivers `mousemove` on the frame boundary, so
 * the observed interval was ~16.6 ms whether we dispatched with no sleep,
 * a 7 ms sleep, or Playwright's own interpolation, and a 40 ms sleep came
 * back as ~50 ms (three frames). Inter-event TIMING is therefore quantised
 * for a human too and carries almost nothing; per-frame DISTANCE is the
 * channel that separates us, which is why every assertion below is about
 * geometry rather than about clocks.
 *
 * These assert on `mouse.move` calls because the path is now hand-rolled.
 * That reverses the earlier decision to delegate, and the reason it can be
 * reversed is that the step now tracks the pointer's own position: the old
 * objection ("we cannot hand-roll because we do not know where the pointer
 * is") stopped being true the moment we started remembering.
 */
const CENTRE_X = 50;
const CENTRE_Y = 20;
const SETTLE_DRIFT_LIMIT_PX = 3;

/** Every `mouse.move` call as an [x, y] pair, in dispatch order. */
function pathOf(page: ReturnType<typeof makePage>): Array<[number, number]> {
  return page.mouse.move.mock.calls.map((call) => [call[0] as number, call[1] as number]);
}

/** Distance between consecutive points of a path. */
function stepsOf(path: Array<[number, number]>): number[] {
  return path
    .slice(1)
    .map(([x, y], i) => Math.hypot(x - (path[i] as [number, number])[0], y - (path[i] as [number, number])[1]));
}

describe('pointer path on click/dblclick/hover', () => {
  it('accelerates and decelerates instead of stepping a constant distance', async () => {
    const locator = makeLocator({
      boundingBox: vi.fn(async () => ({ x: 600, y: 400, width: 100, height: 40 })),
    });
    const page = makePage({ locator: vi.fn(() => locator) as never });
    const { ctx } = makeCtx({ page });

    await runStep(click, ctx, { locator: { selector: '.btn' }, timeout: 5_000 });

    // Drop the two correction hops at the end; the approach is what carries
    // the velocity profile.
    const approach = stepsOf(pathOf(page)).slice(0, -2);

    expect(approach.length).toBeGreaterThanOrEqual(4);

    const largest = Math.max(...approach);
    const smallest = Math.min(...approach);

    // A constant-velocity path makes this ratio 1. A hand's is not close
    // to 1: the middle of the movement is several times faster than the
    // first and last frames of it.
    expect(largest / Math.max(smallest, 0.5)).toBeGreaterThan(2);
  });

  it('lands past the centre and pulls back onto it', async () => {
    const locator = makeLocator({
      boundingBox: vi.fn(async () => ({ x: 600, y: 0, width: 100, height: 40 })),
    });
    const page = makePage({ locator: vi.fn(() => locator) as never });
    const { ctx } = makeCtx({ page });

    await runStep(click, ctx, { locator: { selector: '.btn' }, timeout: 5_000 });

    const path = pathOf(page);
    // Travelling left to right, the approach's furthest point must sit to
    // the RIGHT of the target centre: the hand arrives past it and corrects.
    const centreX = 650;
    const furthest = Math.max(...path.map(([x]) => x));

    expect(furthest).toBeGreaterThan(centreX);
    // And the last point is the centre itself, not the overshoot.
    expect(path.at(-1)).toEqual([centreX, 20]);
  });

  it('does not pile up moves on one pixel when the pointer is already there', async () => {
    // The failure this exists to stop, measured on the live pool container:
    // clicking the same element twice emitted ELEVEN mousemove events at
    // the identical coordinate, because Playwright's interpolation divides
    // a zero-length line into twelve equal parts. Arkose's own collector
    // discards a move under 5 px, so what a detector actually saw was a
    // click with no movement in front of it.
    const locator = makeLocator();
    const page = makePage({ locator: vi.fn(() => locator) as never });
    const { ctx } = makeCtx({ page });

    await runStep(click, ctx, { locator: { selector: '.btn' }, timeout: 5_000 });
    page.mouse.move.mockClear();
    await runStep(click, ctx, { locator: { selector: '.btn' }, timeout: 5_000 });

    const path = pathOf(page);

    expect(path.length).toBeLessThanOrEqual(3);
    // Whatever it does emit, it does not emit the same point twice running.
    for (let i = 1; i < path.length; i++) {
      expect(path[i]).not.toEqual(path[i - 1]);
    }
  });

  it('emits fewer points for a short hop than for a long one', async () => {
    const near = makeLocator({
      boundingBox: vi.fn(async () => ({ x: 0, y: 0, width: 40, height: 20 })),
    });
    const nearPage = makePage({ locator: vi.fn(() => near) as never });
    await runStep(click, makeCtx({ page: nearPage }).ctx, {
      locator: { selector: '.a' },
      timeout: 5_000,
    });

    const far = makeLocator({
      boundingBox: vi.fn(async () => ({ x: 1400, y: 800, width: 40, height: 20 })),
    });
    const farPage = makePage({ locator: vi.fn(() => far) as never });
    await runStep(click, makeCtx({ page: farPage }).ctx, {
      locator: { selector: '.b' },
      timeout: 5_000,
    });

    expect(nearPage.mouse.move.mock.calls.length).toBeLessThan(
      farPage.mouse.move.mock.calls.length,
    );
  });

  it('keeps the peak per-frame displacement inside a hand\'s reach on a long travel', async () => {
    // Chrome delivers one move per frame, so displacement per point IS
    // velocity in px per ~16.6 ms. A long path divided into a fixed number
    // of points would teleport tens of pixels per frame; the point count
    // grows with distance instead.
    const locator = makeLocator({
      boundingBox: vi.fn(async () => ({ x: 1800, y: 1000, width: 40, height: 20 })),
    });
    const page = makePage({ locator: vi.fn(() => locator) as never });
    const { ctx } = makeCtx({ page });

    await runStep(click, ctx, { locator: { selector: '.far' }, timeout: 5_000 });

    const largest = Math.max(...stepsOf(pathOf(page)));

    // The profile peaks around 1.5x the mean step, so the mean is held
    // below the cap and the peak is checked against it with that headroom.
    expect(largest).toBeLessThanOrEqual(POINTER_MAX_STEP_PX * 2);
  });

  it('settles with a small tremor rather than freezing on the centre', async () => {
    const locator = makeLocator();
    const page = makePage({ locator: vi.fn(() => locator) as never });
    const { ctx } = makeCtx({ page });

    await runStep(click, ctx, { locator: { selector: '.btn' }, timeout: 5_000 });

    const path = pathOf(page);
    const settle = path.at(-2) as [number, number];

    expect(Math.abs(settle[0] - CENTRE_X)).toBeGreaterThanOrEqual(1);
    expect(Math.abs(settle[0] - CENTRE_X)).toBeLessThanOrEqual(SETTLE_DRIFT_LIMIT_PX);
    expect(Math.abs(settle[1] - CENTRE_Y)).toBeGreaterThanOrEqual(1);
    expect(Math.abs(settle[1] - CENTRE_Y)).toBeLessThanOrEqual(SETTLE_DRIFT_LIMIT_PX);
  });

  it('moves before the action, never after or interleaved', async () => {
    const locator = makeLocator();
    const page = makePage({ getByTestId: vi.fn(() => locator) as never });
    const { ctx } = makeCtx({ page });

    await runStep(click, ctx, { locator: { testid: 'cta' }, timeout: 5_000 });

    const lastMove = page.mouse.move.mock.invocationCallOrder.at(-1) ?? 0;
    const clickOrder = locator.click.mock.invocationCallOrder[0] ?? 0;

    expect(lastMove).toBeLessThan(clickOrder);
  });

  it('dblclick and hover draw the same path before their own action', async () => {
    for (const [step, method] of [
      [dblclick, 'dblclick'],
      [hover, 'hover'],
    ] as const) {
      const locator = makeLocator();
      const page = makePage({ locator: vi.fn(() => locator) as never });
      const { ctx } = makeCtx({ page });

      await runStep(step, ctx, { locator: { selector: '.row' }, timeout: 5_000 });

      expect(page.mouse.move.mock.calls.length).toBeGreaterThan(1);
      expect(pathOf(page).at(-1)).toEqual([CENTRE_X, CENTRE_Y]);
      expect(locator[method]).toHaveBeenCalled();
    }
  });

  it('does not move the pointer when the element has no bounding box (detached)', async () => {
    const locator = makeLocator({ boundingBox: vi.fn(async () => null) });
    const page = makePage({ locator: vi.fn(() => locator) as never });
    const { ctx } = makeCtx({ page });

    await runStep(click, ctx, { locator: { selector: '.gone' }, timeout: 5_000 });

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
    expect(DEFAULT_POINTER_STEPS).toBeGreaterThan(1);
  });
});
