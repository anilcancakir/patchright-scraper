import { describe, expect, it, vi } from 'vitest';
import { scrollBy, scrollModal, scrollUntilPlateau } from '../../src/steps/scroll.js';
import {
  routeBlock,
  setExtraHTTPHeaders,
  setGeolocation,
  setOffline,
  setUserAgent,
  setViewportSize,
} from '../../src/steps/page.js';
import { makeContext, makeCtx, makeLocator, makePage } from './_helpers.js';

describe('scroll + page primitives', () => {
  it('scrollBy calls window.scrollBy via page.evaluate', async () => {
    const evalSpy = vi.fn(async () => undefined);
    const page = makePage({ evaluate: evalSpy as never });
    const { ctx } = makeCtx({ page });

    await scrollBy.execute(ctx, { x: 0, y: 800 });

    expect(evalSpy).toHaveBeenCalled();
  });

  it('scrollUntilPlateau stops when scrollHeight stabilises', async () => {
    const heights = [1000, 1500, 1500, 1500];
    let i = 0;
    const evalSpy = vi.fn(async () => heights[i++]);
    const page = makePage({ evaluate: evalSpy as never });
    const { ctx } = makeCtx({ page });

    const result = await scrollUntilPlateau.execute(ctx, {
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

    const result = await scrollModal.execute(ctx, {
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

    await setViewportSize.execute(ctx, { width: 1280, height: 720 });

    expect(page.setViewportSize).toHaveBeenCalledWith({ width: 1280, height: 720 });
  });

  it('setUserAgent records the override but flags it deferred', async () => {
    const { ctx } = makeCtx();

    const result = await setUserAgent.execute(ctx, { userAgent: 'Mozilla/5.0 (custom)' });

    expect(result.ok).toBe(true);
    expect((result.output as { appliedImmediately: boolean }).appliedImmediately).toBe(false);
  });

  it('setExtraHTTPHeaders forwards to context.setExtraHTTPHeaders', async () => {
    const context = makeContext();
    const { ctx } = makeCtx({ context });

    await setExtraHTTPHeaders.execute(ctx, { headers: { 'X-Test': '1' } });

    expect(context.setExtraHTTPHeaders).toHaveBeenCalledWith({ 'X-Test': '1' });
  });

  it('setOffline toggles context offline mode', async () => {
    const context = makeContext();
    const { ctx } = makeCtx({ context });

    await setOffline.execute(ctx, { offline: true });

    expect(context.setOffline).toHaveBeenCalledWith(true);
  });

  it('setGeolocation grants permission and sets coordinates', async () => {
    const context = makeContext();
    const { ctx } = makeCtx({ context });

    await setGeolocation.execute(ctx, { latitude: 41, longitude: 29 });

    expect(context.grantPermissions).toHaveBeenCalledWith(['geolocation']);
    expect(context.setGeolocation).toHaveBeenCalledWith(
      expect.objectContaining({ latitude: 41, longitude: 29 }),
    );
  });

  it('routeBlock registers an abort handler per pattern', async () => {
    const context = makeContext();
    const { ctx } = makeCtx({ context });

    await routeBlock.execute(ctx, { patterns: ['**/*.png', '**/analytics.js'] });

    expect(context.route).toHaveBeenCalledTimes(2);
  });
});
