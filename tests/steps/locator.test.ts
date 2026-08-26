import { describe, expect, it, vi } from 'vitest';
import {
  LocatorSpec,
  LocatorUnresolvedError,
  resolveLocator,
  resolveLocatorOrFirst,
} from '../../src/steps/locator.js';
import { makeLocator, makePage } from './_helpers.js';

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

  it('reports the budget left so the action does not get a fresh timeout', async () => {
    const { page } = pageWithTestIds({ here: 1 });

    const resolved = await resolveLocator(page as never, [{ testid: 'here' }], 5_000);

    expect(resolved.remainingMs).toBeGreaterThan(0);
    expect(resolved.remainingMs).toBeLessThanOrEqual(5_000);
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
