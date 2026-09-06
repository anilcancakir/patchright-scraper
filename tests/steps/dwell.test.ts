import { describe, expect, it } from 'vitest';
import { waitForTimeout } from '../../src/steps/wait.js';
import { makeCtx, runStep } from './_helpers.js';

/**
 * A dwell that is always the same length is not a dwell.
 *
 * The recipes pause so a read looks like someone reading rather than a
 * page opened and scraped in four seconds. A pause of exactly 9000ms on
 * every run replaces "no idle time at all" with "an idle time nobody has
 * twice", which is the same uniformity tell this codebase already
 * removed from typing and from scrolling.
 */
describe('waitForTimeout', () => {
  it('waits exactly as told by default, because a deadline is not a dwell', async () => {
    const { ctx } = makeCtx({});

    const result = await runStep(waitForTimeout, ctx, { ms: 5 });

    expect((result.output as { waitedMs: number }).waitedMs).toBe(5);
  });

  it('draws a different length every time when asked to jitter', async () => {
    const { ctx } = makeCtx({});
    const draws = new Set<number>();

    for (let i = 0; i < 12; i += 1) {
      const result = await runStep(waitForTimeout, ctx, { ms: 40, jitter: true });
      draws.add((result.output as { waitedMs: number }).waitedMs);
    }

    expect(draws.size).toBeGreaterThan(1);
  });

  it('reports what it actually waited, not what it was asked for', async () => {
    // The run row is the only place an operator can see whether a dwell
    // happened, so a jittered wait that echoed its nominal value would
    // make the feature unobservable.
    const { ctx } = makeCtx({});

    const result = await runStep(waitForTimeout, ctx, { ms: 30, jitter: true });
    const waited = (result.output as { waitedMs: number }).waitedMs;

    expect(waited).toBeGreaterThan(0);
    expect(Number.isInteger(waited)).toBe(true);
  });

  it('leaves a zero wait alone', async () => {
    const { ctx } = makeCtx({});

    const result = await runStep(waitForTimeout, ctx, { ms: 0, jitter: true });

    expect((result.output as { waitedMs: number }).waitedMs).toBe(0);
  });
});
