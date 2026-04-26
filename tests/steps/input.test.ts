import { describe, expect, it, vi } from 'vitest';
import {
  blur,
  check,
  click,
  dblclick,
  dragTo,
  fill,
  focus,
  hover,
  press,
  scrollIntoViewIfNeeded,
  selectOption,
  setInputFiles,
  type,
} from '../../src/steps/input.js';
import { makeCtx, makeLocator, makePage } from './_helpers.js';

describe('input primitives (Playwright shape)', () => {
  it('click resolves locator and clicks with options', async () => {
    const locator = makeLocator();
    const page = makePage({ getByTestId: vi.fn(() => locator) as never });
    const { ctx } = makeCtx({ page });

    await click.execute(ctx, {
      locator: { testid: 'cta' },
      button: 'left',
      clickCount: 1,
      delay: 0,
      force: false,
      timeout: 5_000,
    });

    expect(page.getByTestId).toHaveBeenCalledWith('cta');
    expect(locator.click).toHaveBeenCalledWith(
      expect.objectContaining({ button: 'left', clickCount: 1 }),
    );
  });

  it('dblclick double-clicks the locator', async () => {
    const locator = makeLocator();
    const page = makePage({ locator: vi.fn(() => locator) as never });
    const { ctx } = makeCtx({ page });

    await dblclick.execute(ctx, {
      locator: { selector: '.row' },
      button: 'left',
      delay: 0,
      force: false,
      timeout: 5_000,
    });

    expect(locator.dblclick).toHaveBeenCalled();
  });

  it('fill writes the value via locator.fill (instant)', async () => {
    const locator = makeLocator();
    const page = makePage({ getByLabel: vi.fn(() => locator) as never });
    const { ctx } = makeCtx({ page });

    await fill.execute(ctx, {
      locator: { label: 'Email' },
      value: 'a@b.test',
      timeout: 5_000,
    });

    expect(locator.fill).toHaveBeenCalledWith('a@b.test', expect.objectContaining({ timeout: 5_000 }));
  });

  it('type clears first and types per character', async () => {
    const locator = makeLocator();
    const page = makePage({ getByPlaceholder: vi.fn(() => locator) as never });
    const { ctx } = makeCtx({ page });

    await type.execute(ctx, {
      locator: { placeholder: 'Search' },
      text: 'hello',
      delay: 0,
      clear: true,
      timeout: 5_000,
    });

    expect(locator.fill).toHaveBeenCalledWith('', expect.any(Object));
    expect(locator.type).toHaveBeenCalledWith('hello', expect.objectContaining({ delay: 0 }));
  });

  it('press uses locator.press when locator given, keyboard.press otherwise', async () => {
    const locator = makeLocator();
    const page = makePage({ getByRole: vi.fn(() => locator) as never });
    const { ctx } = makeCtx({ page });

    await press.execute(ctx, {
      key: 'Enter',
      locator: { role: 'textbox' },
      delay: 0,
    });
    expect(locator.press).toHaveBeenCalledWith('Enter', expect.any(Object));

    await press.execute(ctx, { key: 'Escape', delay: 0 });
    expect(page.keyboard.press).toHaveBeenCalledWith('Escape', expect.any(Object));
  });

  it('hover, focus, blur, scrollIntoViewIfNeeded delegate to the locator', async () => {
    const locator = makeLocator();
    const page = makePage({ locator: vi.fn(() => locator) as never });
    const { ctx } = makeCtx({ page });

    await hover.execute(ctx, { locator: { selector: '.h' }, force: false, timeout: 5_000 });
    await focus.execute(ctx, { locator: { selector: '.h' }, timeout: 5_000 });
    await blur.execute(ctx, { locator: { selector: '.h' }, timeout: 5_000 });
    await scrollIntoViewIfNeeded.execute(ctx, {
      locator: { selector: '.h' },
      timeout: 5_000,
    });

    expect(locator.hover).toHaveBeenCalled();
    expect(locator.focus).toHaveBeenCalled();
    expect(locator.blur).toHaveBeenCalled();
    expect(locator.scrollIntoViewIfNeeded).toHaveBeenCalled();
  });

  it('dragTo passes both source and target locators', async () => {
    const source = makeLocator();
    const target = makeLocator();
    let call = 0;
    const page = makePage({
      locator: vi.fn(() => (call++ === 0 ? source : target)) as never,
    });
    const { ctx } = makeCtx({ page });

    await dragTo.execute(ctx, {
      locator: { selector: '.from' },
      target: { selector: '.to' },
      force: false,
      timeout: 5_000,
    });

    expect(source.dragTo).toHaveBeenCalled();
  });

  it('selectOption returns the selected values', async () => {
    const locator = makeLocator({ selectOption: vi.fn(async () => ['tr']) });
    const page = makePage({ getByRole: vi.fn(() => locator) as never });
    const { ctx } = makeCtx({ page });

    const result = await selectOption.execute(ctx, {
      locator: { role: 'combobox' },
      values: ['tr'],
      timeout: 5_000,
    });

    expect(result.ok).toBe(true);
    expect((result.output as { selected: string[] }).selected).toEqual(['tr']);
  });

  it('check toggles based on state', async () => {
    const locator = makeLocator();
    const page = makePage({ locator: vi.fn(() => locator) as never });
    const { ctx } = makeCtx({ page });

    await check.execute(ctx, { locator: { selector: 'input.box' }, state: true, timeout: 5_000 });
    expect(locator.check).toHaveBeenCalled();

    await check.execute(ctx, { locator: { selector: 'input.box' }, state: false, timeout: 5_000 });
    expect(locator.uncheck).toHaveBeenCalled();
  });

  it('setInputFiles decodes base64 and forwards to the locator', async () => {
    const locator = makeLocator();
    const page = makePage({ getByTestId: vi.fn(() => locator) as never });
    const { ctx } = makeCtx({ page });
    const payload = Buffer.from('hello').toString('base64');

    const result = await setInputFiles.execute(ctx, {
      locator: { testid: 'upload' },
      source: 'base64',
      payload,
      filename: 'demo.txt',
      mimeType: 'text/plain',
      timeout: 5_000,
    });

    expect(locator.setInputFiles).toHaveBeenCalled();
    const [args] = locator.setInputFiles.mock.calls;
    expect((args![0] as { name: string }).name).toBe('demo.txt');
    expect(result.ok).toBe(true);
    expect((result.output as { bytes: number }).bytes).toBe(5);
  });
});
