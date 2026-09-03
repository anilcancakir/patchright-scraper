import { describe, expect, it } from 'vitest';
import type { Page } from 'patchright';
import { LocatorUnresolvedError, resolveLocator } from '../src/steps/locator.js';

/**
 * Budget arithmetic in resolveLocator.
 *
 * Every action step spends `remainingMs` as its Playwright timeout, so
 * whatever resolution leaves behind is the entire chance the click, fill
 * or type gets. A production A/B on 2026-09-03 lost 16 of 90 CDP trials
 * to `locator.click: Timeout 1000ms exceeded`, 14 of them on one
 * re-rendering SPA, because resolution had swept the whole budget and
 * handed the action the floor.
 *
 * These tests pin the property that fixes it: the action's share scales
 * with the declared timeout instead of collapsing to a constant.
 */

/**
 * The smallest Page a `{ selector }` candidate touches: baseLocator calls
 * `page.locator()`, and matchCandidate calls `count()` plus `nth()`.
 *
 * `counts` is consulted by elapsed time rather than by call number, so a
 * test says "still unresolved at 600ms" instead of guessing how many
 * sweeps that is.
 */
function pageReturning(countAt: (elapsedMs: number) => number): Page {
  const startedAt = Date.now();

  const locator = {
    count: async () => countAt(Date.now() - startedAt),
    nth: () => locator,
  };

  return { locator: () => locator } as unknown as Page;
}

const SELECTOR = [{ selector: '#target' }];

describe('resolveLocator budget', () => {
  it('stops resolving at the reserve boundary rather than handing the action a doomed budget', async () => {
    // The candidate stays ambiguous until almost the whole budget is
    // gone, which is what a re-rendering SPA does to `count()`. The old
    // arithmetic RESOLVED here and handed the click 1_000ms, which then
    // failed as `locator.click: Timeout 1000ms exceeded` with the real
    // cause ("matched 2 elements") already discarded. Failing in
    // resolution keeps the cause and is the honest outcome.
    const page = pageReturning((elapsed) => (elapsed < 3_400 ? 2 : 1));

    await expect(resolveLocator(page, SELECTOR, 4_000)).rejects.toThrow(/matched 2 elements/);
  });

  it('lets a larger step timeout actually buy the action a budget', async () => {
    // The point of the reserve. Under the old arithmetic raising
    // `timeout` fed resolution alone: the same late match still left the
    // action exactly 1_000ms whether the step allowed 4s or 40s.
    const page = pageReturning((elapsed) => (elapsed < 3_400 ? 2 : 1));

    const resolved = await resolveLocator(page, SELECTOR, 8_000);

    expect(resolved.remainingMs).toBeGreaterThanOrEqual(2_400);
  });

  it('never lets resolution plus action exceed the declared timeout', async () => {
    // Late enough that the old floor kicked in and pushed the total past
    // the declared timeout, early enough to still resolve.
    const page = pageReturning((elapsed) => (elapsed < 2_400 ? 2 : 1));

    const startedAt = Date.now();
    const resolved = await resolveLocator(page, SELECTOR, 4_000);
    const spentOnResolution = Date.now() - startedAt;

    expect(spentOnResolution + resolved.remainingMs).toBeLessThanOrEqual(4_000);
  });

  it('leaves a fast resolution almost the whole budget', async () => {
    const page = pageReturning(() => 1);

    const resolved = await resolveLocator(page, SELECTOR, 4_000);

    expect(resolved.remainingMs).toBeGreaterThan(3_500);
  });

  it('still lets a sub-second step sweep, and still gives its action the floor', async () => {
    // Below about 3.3s the reserve would be the floor, and taking the
    // floor out of a 600ms window would leave resolution no sweeps at
    // all. The reserve is capped at half the timeout for exactly this,
    // so a candidate appearing at 150ms is still found.
    const page = pageReturning((elapsed) => (elapsed < 150 ? 0 : 1));

    const resolved = await resolveLocator(page, SELECTOR, 600);

    // The floor deliberately exceeds the declared timeout here. A 600ms
    // step is an authoring slip, and `tests/steps/locator.test.ts` pins
    // the same invariant at a 1ms timeout: an action must never be handed
    // a budget too small to work in, because the failure mode of a
    // near-zero timeout is a held browser rather than a fast failure.
    expect(resolved.remainingMs).toBe(1_000);
  });

  it('reports the candidate reasons when resolution runs out, not a bare timeout', async () => {
    // The reason a click used to fail at 1_000ms was usually visible
    // during resolution ("matched 2 elements") and lost by the time the
    // action reported. Failing in resolution keeps it.
    const page = pageReturning(() => 2);

    await expect(resolveLocator(page, SELECTOR, 800)).rejects.toThrow(LocatorUnresolvedError);
    await expect(resolveLocator(page, SELECTOR, 800)).rejects.toThrow(/matched 2 elements/);
  });
});
