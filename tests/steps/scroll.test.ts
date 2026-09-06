import { describe, expect, it, vi } from 'vitest';
import { scrollAndCollect, scrollBy, scrollModal, scrollUntilPlateau } from '../../src/steps/scroll.js';
import {
  routeBlock,
  setExtraHTTPHeaders,
  setGeolocation,
  setOffline,
  setUserAgent,
  setViewportSize,
} from '../../src/steps/page.js';
import { makeContext, makeCtx, makeLocator, makePage, runStep } from './_helpers.js';

describe('scroll + page primitives', () => {
  it('scrollBy calls window.scrollBy via page.evaluate', async () => {
    const evalSpy = vi.fn(async () => undefined);
    const page = makePage({ evaluate: evalSpy as never });
    const { ctx } = makeCtx({ page });

    await runStep(scrollBy, ctx, { x: 0, y: 800 });

    expect(evalSpy).toHaveBeenCalled();
  });

  it('scrollUntilPlateau stops when scrollHeight stabilises', async () => {
    const heights = [1000, 1500, 1500, 1500];
    let i = 0;
    const evalSpy = vi.fn(async () => heights[i++]);
    const page = makePage({ evaluate: evalSpy as never });
    const { ctx } = makeCtx({ page });

    const result = await runStep(scrollUntilPlateau, ctx, {
      maxIterations: 10,
      settleMs: 0,
      plateauIterations: 2,
      stepPx: 800,
    });

    expect(result.ok).toBe(true);
    expect((result.output as { plateau: boolean }).plateau).toBe(true);
  });

  it('scrollModal returns plateau when the modal stops growing', async () => {
    const heights = [400, 500, 500];
    let i = 0;
    const page = makePage({
      waitForSelector: vi.fn(async () => makeLocator() as never),
      evaluate: vi.fn(async () => heights[i++]) as never,
    });
    const { ctx } = makeCtx({ page });

    const result = await runStep(scrollModal, ctx, {
      modalSelector: '.modal',
      maxIterations: 5,
      settleMs: 0,
      stepPx: 200,
      timeout: 5_000,
    });

    expect(result.ok).toBe(true);
    expect((result.output as { plateau: boolean }).plateau).toBe(true);
  });

  it('setViewportSize calls page.setViewportSize', async () => {
    const { ctx, page } = makeCtx();

    await runStep(setViewportSize, ctx, { width: 1280, height: 720 });

    expect(page.setViewportSize).toHaveBeenCalledWith({ width: 1280, height: 720 });
  });

  it('setUserAgent records the override but flags it deferred', async () => {
    const { ctx } = makeCtx();

    const result = await runStep(setUserAgent, ctx, { userAgent: 'Mozilla/5.0 (custom)' });

    expect(result.ok).toBe(true);
    expect((result.output as { appliedImmediately: boolean }).appliedImmediately).toBe(false);
  });

  it('setExtraHTTPHeaders forwards to context.setExtraHTTPHeaders', async () => {
    const context = makeContext();
    const { ctx } = makeCtx({ context });

    await runStep(setExtraHTTPHeaders, ctx, { headers: { 'X-Test': '1' } });

    expect(context.setExtraHTTPHeaders).toHaveBeenCalledWith({ 'X-Test': '1' });
  });

  it('setOffline toggles context offline mode', async () => {
    const context = makeContext();
    const { ctx } = makeCtx({ context });

    await runStep(setOffline, ctx, { offline: true });

    expect(context.setOffline).toHaveBeenCalledWith(true);
  });

  it('setGeolocation grants permission and sets coordinates', async () => {
    const context = makeContext();
    const { ctx } = makeCtx({ context });

    await runStep(setGeolocation, ctx, { latitude: 41, longitude: 29 });

    expect(context.grantPermissions).toHaveBeenCalledWith(['geolocation']);
    expect(context.setGeolocation).toHaveBeenCalledWith(
      expect.objectContaining({ latitude: 41, longitude: 29 }),
    );
  });

  it('routeBlock registers an abort handler per pattern', async () => {
    const context = makeContext();
    const { ctx } = makeCtx({ context });

    await runStep(routeBlock, ctx, { patterns: ['**/*.png', '**/analytics.js'] });

    expect(context.route).toHaveBeenCalledTimes(2);
  });
});

describe('scrollAndCollect', () => {
  /**
   * Simulate a virtualized list: only a window of rows is mounted at any
   * time, and scrolling slides the window down. This is what makes
   * scroll-then-extractDom lose data, and what the step has to survive.
   */
  function virtualizedPage(total: number, windowSize: number) {
    let offset = 0;

    const evaluate = vi.fn(async (_fn: unknown, arg: unknown) => {
      const payload = arg as { stepPx?: number; selector?: string };

      // The scroll half of the loop carries stepPx and returns nothing.
      if (payload.stepPx !== undefined) {
        offset = Math.min(offset + windowSize, Math.max(0, total - windowSize));
        return undefined;
      }

      const rows: Array<{ key: string; row: Record<string, string | null> }> = [];
      for (let i = offset; i < Math.min(offset + windowSize, total); i += 1) {
        rows.push({ key: `/status/${i}`, row: { text: `row ${i}` } });
      }

      return rows;
    });

    return makePage({ evaluate: evaluate as never });
  }

  it('merges every window into one deduped set', async () => {
    const page = virtualizedPage(10, 3);
    const { ctx } = makeCtx({ page });

    const result = await runStep(scrollAndCollect, ctx, {
      name: 'tweets',
      selector: 'article',
      keySelector: 'a[href*="/status/"]',
      settleMs: 0,
    });

    const output = result.output as { rows: unknown[]; exhausted: boolean };

    // A single scroll-then-extract would have returned the last 3.
    expect(output.rows).toHaveLength(10);
    expect(output.exhausted).toBe(true);
  });

  it('never returns the same row twice', async () => {
    const page = virtualizedPage(6, 4);
    const { ctx } = makeCtx({ page });

    const result = await runStep(scrollAndCollect, ctx, {
      name: 'tweets',
      selector: 'article',
      settleMs: 0,
    });

    const rows = (result.output as { rows: Array<{ text: string }> }).rows;

    expect(new Set(rows.map((r) => r.text)).size).toBe(rows.length);
  });

  it('hands back the dedupe key, because it is the only name a post has', async () => {
    // The key is the post's own permalink and the step already computes
    // it. Discarding it left nothing in the system able to address a post
    // it had just read: `reply` takes a status URL and no action could
    // produce one.
    const page = virtualizedPage(3, 3);
    const { ctx } = makeCtx({ page });

    const result = await runStep(scrollAndCollect, ctx, {
      name: 'tweets',
      selector: 'article',
      keySelector: 'a[href*="/status/"]',
      settleMs: 0,
    });

    const rows = (result.output as { rows: Array<Record<string, string>> }).rows;

    expect(rows[0].key).toBe('/status/0');
    expect(rows[2].key).toBe('/status/2');
  });

  it('lets the caller name the key field', async () => {
    const page = virtualizedPage(2, 2);
    const { ctx } = makeCtx({ page });

    const result = await runStep(scrollAndCollect, ctx, {
      name: 'tweets',
      selector: 'article',
      keyField: 'permalink',
      settleMs: 0,
    });

    const rows = (result.output as { rows: Array<Record<string, string>> }).rows;

    expect(rows[0].permalink).toBe('/status/0');
    expect(rows[0].key).toBeUndefined();
  });

  it('carries a fields map through the schema and into the page', async () => {
    // The extraction itself runs inside page.evaluate and is out of reach
    // from here; what this pins is that the config survives the schema and
    // arrives, which is where a strict() object silently rejects a new key.
    const page = virtualizedPage(2, 2);
    const { ctx } = makeCtx({ page });

    const result = await runStep(scrollAndCollect, ctx, {
      name: 'tweets',
      selector: 'article',
      fields: {
        body: { selector: '[data-testid="tweetText"]' },
        permalink: { selector: 'a[href*="/status/"]', attr: 'href' },
      },
      includeText: false,
      settleMs: 0,
    });

    expect(result.ok).toBe(true);

    const passed = (page.evaluate as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0][1] as {
      fields: Record<string, { selector?: string; attr?: string }>;
      includeText: boolean;
    };

    expect(passed.fields.permalink).toEqual({ selector: 'a[href*="/status/"]', attr: 'href' });
    expect(passed.includeText).toBe(false);
  });

  it('fails when it collected fewer rows than the caller requires', async () => {
    // This step could not fail. A row whose key does not resolve is
    // skipped, so a moved permalink silently empties every row, the idle
    // counter trips, and the run reports success with zero results while
    // the waitForSelector in front still passes. That is the shape of a
    // rotted recipe nobody notices.
    const page = virtualizedPage(2, 2);
    const { ctx } = makeCtx({ page });

    const result = await runStep(scrollAndCollect, ctx, {
      name: 'tweets',
      selector: 'article',
      keySelector: 'a[href*="/status/"]',
      minRows: 5,
      settleMs: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('collected 2 rows of a required 5');
    expect(result.error).toContain('a[href*="/status/"]');
  });

  it('leaves a collector with no floor alone', async () => {
    // minRows defaults to 0, so every stored recipe keeps its behaviour.
    const page = virtualizedPage(0, 3);
    const { ctx } = makeCtx({ page });

    const result = await runStep(scrollAndCollect, ctx, {
      name: 'tweets',
      selector: 'article',
      settleMs: 0,
    });

    expect(result.ok).toBe(true);
  });

  it('stops at maxRows and says it was not exhausted', async () => {
    const page = virtualizedPage(50, 5);
    const { ctx } = makeCtx({ page });

    const result = await runStep(scrollAndCollect, ctx, {
      name: 'tweets',
      selector: 'article',
      maxRows: 12,
      settleMs: 0,
    });

    const output = result.output as { rows: unknown[]; exhausted: boolean };

    expect(output.rows).toHaveLength(12);
    expect(output.exhausted).toBe(false);
  });

  // Not covered here: the keyless-row filter and the attribute reads,
  // which live inside the function handed to page.evaluate and therefore
  // run in the browser. This harness replaces evaluate wholesale, so a
  // test for them would be asserting against the mock rather than the
  // step. They need a real page.
});
