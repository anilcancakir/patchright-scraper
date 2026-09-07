import { describe, expect, it, vi } from 'vitest';

import { composeThread } from '../../src/steps/input.js';
import { makeCtx, makeLocator, makePage, runStep } from './_helpers.js';

/**
 * A composer that offers completions puts an invisible layer over itself.
 *
 * While the caret sits inside a `#hashtag` or an `@mention`, x.com mounts
 * a typeahead container that renders nothing and is an empty inset-0 div
 * across the whole dialog. The control underneath stays visible and
 * enabled, and every click on it is swallowed.
 *
 * Measured on production 2026-09-07 with a two-part thread whose first
 * part ended in `#FlutterDev`: `locator.click` on the add control retried
 * for its full 30s with "element is visible, enabled and stable" then
 * "subtree intercepts pointer events", twice, deterministically. No part
 * was ever posted, so the failure was at least loud rather than a half
 * thread, but a thread with a tag on any part but the last could not be
 * composed at all.
 *
 * A trailing space ends the token and the sites this drives trim it on
 * submit, so it is the smallest correct dismissal. `Escape` is not
 * usable: with no popup open, x.com binds it to closing the composer.
 */
describe('composeThread dismisses a typeahead before it clicks', () => {
  it('presses Space after every part, including the last', async () => {
    const locator = makeLocator();
    (locator as unknown as { nth: unknown }).nth = vi.fn(() => locator);
    const page = makePage({ locator: vi.fn(() => locator) as never });
    const { ctx } = makeCtx({ page });

    await runStep(composeThread, ctx, {
      editorTemplate: '[data-testid="tweetTextarea_{index}"]',
      addButton: { selector: '[data-testid="addButton"]' },
      parts: ['first #tag', 'second #tag'],
      delay: 5,
      timeout: 5_000,
    });

    // The last part matters as much as the ones between: it is the one
    // the publish click has to get past.
    expect(page.keyboard.press.mock.calls.map((call) => call[0])).toEqual(['Space', 'Space']);
  });

  it('dismisses on the insertText path too', async () => {
    // `delay: 0` is the documented opt-out that commits a part whole.
    // The typeahead does not care how the text arrived.
    const locator = makeLocator();
    (locator as unknown as { nth: unknown }).nth = vi.fn(() => locator);
    const page = makePage({ locator: vi.fn(() => locator) as never });
    const { ctx } = makeCtx({ page });

    await runStep(composeThread, ctx, {
      editorTemplate: '#e{index}',
      addButton: { selector: '#add' },
      parts: ['only #tag'],
      delay: 0,
      timeout: 5_000,
    });

    expect(page.keyboard.insertText).toHaveBeenCalledOnce();
    expect(page.keyboard.press).toHaveBeenCalledWith('Space');
  });
});
