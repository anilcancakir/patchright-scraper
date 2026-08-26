import { describe, expect, it, vi } from 'vitest';
import {
  LocatorSpec,
  LocatorUnresolvedError,
  resolveLocator,
  resolveLocatorOrFirst,
} from '../../src/steps/locator.js';
import { waitForSelector } from '../../src/steps/wait.js';
import { makeCtx, makeLocator, makePage, runStep } from './_helpers.js';

/**
 * Build a page whose testid lookups answer per key, so a chain can be
 * driven candidate by candidate.
 *
 * `counts` maps a testid to how many elements it matches. An absent key
 * matches nothing, which is what a selector that has rotted looks like.
 */
function pageWithTestIds(counts: Record<string, number>) {
  const locators = new Map<string, ReturnType<typeof makeLocator>>();

  const factory = vi.fn((testid: string) => {
    const existing = locators.get(testid);
    if (existing !== undefined) {
      return existing;
    }

    const count = counts[testid] ?? 0;
    const locator = makeLocator({
      count: vi.fn(async () => count),
      nth: vi.fn(() => locator),
    } as never);
    locators.set(testid, locator);

    return locator;
  });

  return { page: makePage({ getByTestId: factory as never }), factory, locators };
}

describe('locator chains', () => {
  it('normalises a single candidate into a one-element list', () => {
    const parsed = LocatorSpec.parse({ testid: 'only' });

    expect(parsed).toEqual([{ testid: 'only' }]);
  });

  it('keeps an explicit chain in the order it was written', () => {
    const parsed = LocatorSpec.parse([{ testid: 'first' }, { selector: '.second' }]);

    expect(parsed).toEqual([{ testid: 'first' }, { selector: '.second' }]);
  });

  it('rejects an empty chain at the schema boundary', () => {
    expect(() => LocatorSpec.parse([])).toThrow();
  });

  it('returns the first candidate that matches, with its index', async () => {
    const { page } = pageWithTestIds({ preferred: 1, fallback: 1 });

    const resolved = await resolveLocator(
      page as never,
      [{ testid: 'preferred' }, { testid: 'fallback' }],
      1_000,
    );

    expect(resolved.index).toBe(0);
  });

  it('falls through to the next candidate when the preferred one is gone', async () => {
    // The DM composer testids changed under us in production; this is
    // the shape of that failure and the reason chains exist.
    const { page } = pageWithTestIds({ 'dm-composer-textarea': 1 });

    const resolved = await resolveLocator(
      page as never,
      [{ testid: 'dmComposerTextInput' }, { testid: 'dm-composer-textarea' }],
      1_000,
    );

    expect(resolved.index).toBe(1);
  });

  it('rejects a multi-match candidate rather than tripping strict mode', async () => {
    // Playwright throws on an action against a locator matching several
    // elements, so ACCEPTING this candidate would skip the working
    // fallback and then fail anyway: the worst of both.
    const { page } = pageWithTestIds({ ambiguous: 4, exact: 1 });

    const resolved = await resolveLocator(
      page as never,
      [{ testid: 'ambiguous' }, { testid: 'exact' }],
      1_000,
    );

    expect(resolved.index).toBe(1);
  });

  it('accepts a multi-match candidate that says which one it means', async () => {
    const { page } = pageWithTestIds({ ambiguous: 4 });

    const resolved = await resolveLocator(
      page as never,
      [{ testid: 'ambiguous', nth: 0 }],
      1_000,
    );

    expect(resolved.index).toBe(0);
  });

  it('throws once the shared budget runs out, naming every candidate tried', async () => {
    const { page } = pageWithTestIds({});

    await expect(
      resolveLocator(page as never, [{ testid: 'gone' }, { testid: 'also-gone' }], 250),
    ).rejects.toThrow(LocatorUnresolvedError);
  });

  it('spends one budget across the whole chain, not one per candidate', async () => {
    // Attempting each candidate in turn would multiply the step timeout
    // by the chain length; a three-candidate chain on the default 10s
    // would spend half a minute failing to find one missing element.
    const { page } = pageWithTestIds({});
    const candidates = [{ testid: 'a' }, { testid: 'b' }, { testid: 'c' }];

    const startedAt = Date.now();
    await expect(resolveLocator(page as never, candidates, 300)).rejects.toThrow();
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(900);
  });

  it('says which problem a candidate had, because the fixes differ', async () => {
    // "Nothing there" means the selector is wrong. "Several there" means
    // it is right and the recipe has to say which one. Conflating them
    // cost a live debugging session on a timeline, where one testid
    // legitimately covers twenty articles.
    const { page } = pageWithTestIds({ crowded: 20 });

    await expect(
      resolveLocator(page as never, [{ testid: 'crowded' }, { testid: 'absent' }], 150),
    ).rejects.toThrow(/matched 20 elements; add "nth" to pick one/);

    await expect(
      resolveLocator(page as never, [{ testid: 'crowded' }, { testid: 'absent' }], 150),
    ).rejects.toThrow(/matched nothing/);
  });

  it('keeps going when a candidate throws instead of simply not matching', async () => {
    // count() is not exception-free: mid-navigation it raises "Execution
    // context was destroyed", and an unrecognised ARIA role raises too.
    // Candidate 0 rotting into an ERROR rather than into a non-match is
    // exactly the case a chain exists for, so it must not take the chain
    // down with it.
    const exploding = makeLocator({
      count: vi.fn(async () => {
        throw new Error('Execution context was destroyed');
      }),
    } as never);
    const working = makeLocator({ count: vi.fn(async () => 1) } as never);

    const page = makePage({
      getByTestId: vi.fn((testid: string) => (testid === 'boom' ? exploding : working)) as never,
    });

    const resolved = await resolveLocator(
      page as never,
      [{ testid: 'boom' }, { testid: 'fine' }],
      1_000,
    );

    expect(resolved.index).toBe(1);
  });

  it('never hands an action a zero budget, which Playwright reads as no timeout', async () => {
    // timeout: 0 means "wait forever" to Playwright, not "fail now", so a
    // candidate matching on the last sweep would leave the click that
    // follows hanging until the queue worker's own timeout kills it.
    const { page } = pageWithTestIds({ late: 1 });

    const resolved = await resolveLocator(page as never, [{ testid: 'late' }], 1);

    expect(resolved.remainingMs).toBeGreaterThanOrEqual(1_000);
  });

  it('reports the budget left so the action does not get a fresh timeout', async () => {
    const { page } = pageWithTestIds({ here: 1 });

    const resolved = await resolveLocator(page as never, [{ testid: 'here' }], 5_000);

    expect(resolved.remainingMs).toBeGreaterThan(0);
    expect(resolved.remainingMs).toBeLessThanOrEqual(5_000);
  });
});

describe('waitForSelector chains', () => {
  it('polls for a chain when waiting for an element to appear', async () => {
    // The element is normally NOT there when this step starts, which is
    // the whole reason it exists. A single-sweep resolver would match
    // nothing, fall back to candidate 0 and wait on that alone, leaving
    // every fallback in the chain dead and locatorIndex pinned at 0.
    const { page } = pageWithTestIds({ fallback: 1 });
    const { ctx } = makeCtx({ page });

    const result = await runStep(waitForSelector, ctx, {
      locator: [{ testid: 'preferred' }, { testid: 'fallback' }],
      state: 'visible',
      timeout: 1_000,
    });

    expect((result.output as { locatorIndex: number }).locatorIndex).toBe(1);
  });

  it('does not poll when waiting for an element to go away', async () => {
    // 'hidden' and 'detached' are satisfied BY nothing matching, so a
    // resolver that threw on an empty page would fail the wait it should
    // have passed.
    const { page } = pageWithTestIds({});
    const { ctx } = makeCtx({ page });

    const result = await runStep(waitForSelector, ctx, {
      locator: [{ testid: 'gone' }, { testid: 'also-gone' }],
      state: 'hidden',
      timeout: 1_000,
    });

    expect(result.ok).toBe(true);
  });
});

describe('resolveLocatorOrFirst', () => {
  it('picks the matching candidate when there is one', async () => {
    const { page } = pageWithTestIds({ second: 1 });

    const resolved = await resolveLocatorOrFirst(page as never, [
      { testid: 'first' },
      { testid: 'second' },
    ]);

    expect(resolved.index).toBe(1);
  });

  it('falls back to the preferred candidate when nothing matches', async () => {
    // toBeHidden and waitFor(state: 'hidden') are satisfied BY nothing
    // matching, so throwing here would fail the assertion it should
    // have passed.
    const { page, locators } = pageWithTestIds({});

    const resolved = await resolveLocatorOrFirst(page as never, [
      { testid: 'preferred' },
      { testid: 'other' },
    ]);

    expect(resolved.index).toBe(0);
    expect(resolved.locator).toBe(locators.get('preferred'));
  });
});
