import { describe, expect, it, vi } from 'vitest';
import {
  scroll_by,
  scroll_modal,
  scroll_to,
  scroll_until_plateau,
  set_user_agent,
  set_viewport,
} from '../../src/steps/scroll.js';
import { makeCtx, makeHandle, makePage } from './_helpers.js';

describe('scroll + viewport primitives', () => {
  it('scroll_to scrolls the resolved handle into view', async () => {
    const handleEval = vi.fn(async () => undefined);
    const page = makePage({ waitForSelector: vi.fn(async () => makeHandle({ evaluate: handleEval }) as never) });
    const { ctx } = makeCtx({ page });

    const result = await scroll_to.execute(ctx, {
      selector: '#footer',
      behavior: 'smooth',
      block: 'center',
      timeout_ms: 5_000,
    });

    expect(result.ok).toBe(true);
    expect(handleEval).toHaveBeenCalled();
  });

  it('scroll_by calls window.scrollBy via page.evaluate', async () => {
    const evaluate = vi.fn(async () => undefined);
    const page = makePage({ evaluate: evaluate as never });
    const { ctx } = makeCtx({ page });

    await scroll_by.execute(ctx, { x: 0, y: 800 });

    expect(evaluate).toHaveBeenCalled();
  });

  it('scroll_until_plateau stops when scrollHeight stabilises', async () => {
    // Three calls: 1000, 1500, 1500 (plateau hit on the 3rd at default plateau_iterations=2 -> needs 2 hits).
    const heights = [1000, 1500, 1500, 1500];
    let i = 0;
    const evaluate = vi.fn(async () => heights[i++]);
    const page = makePage({ evaluate: evaluate as never });
    const { ctx } = makeCtx({ page });

    const result = await scroll_until_plateau.execute(ctx, {
      max_iterations: 10,
      settle_ms: 0,
      plateau_iterations: 2,
      step_px: 800,
    });

    expect(result.ok).toBe(true);
    expect((result.output as { plateau: boolean }).plateau).toBe(true);
  });

  it('scroll_modal returns plateau when the modal stops growing', async () => {
    const heights = [400, 500, 500];
    let i = 0;
    const page = makePage({
      waitForSelector: vi.fn(async () => makeHandle() as never),
      evaluate: vi.fn(async () => heights[i++]) as never,
    });
    const { ctx } = makeCtx({ page });

    const result = await scroll_modal.execute(ctx, {
      modal_selector: '.modal',
      max_iterations: 5,
      settle_ms: 0,
      step_px: 200,
      timeout_ms: 5_000,
    });

    expect(result.ok).toBe(true);
    expect((result.output as { plateau: boolean }).plateau).toBe(true);
  });

  it('set_viewport calls page.setViewportSize', async () => {
    const { ctx, page } = makeCtx();

    await set_viewport.execute(ctx, { width: 1280, height: 720 });

    expect(page.setViewportSize).toHaveBeenCalledWith({ width: 1280, height: 720 });
  });

  it('set_user_agent records the override but flags it deferred', async () => {
    const { ctx } = makeCtx();

    const result = await set_user_agent.execute(ctx, { user_agent: 'Mozilla/5.0 (custom)' });

    expect(result.ok).toBe(true);
    expect((result.output as { applied_immediately: boolean }).applied_immediately).toBe(false);
  });
});
