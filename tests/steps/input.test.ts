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
  insertText,
  press,
  scrollIntoViewIfNeeded,
  selectOption,
  setInputFiles,
  type,
} from '../../src/steps/input.js';
import { makeCtx, makeLocator, makePage, runStep } from './_helpers.js';

describe('input primitives (Playwright shape)', () => {
  it('click resolves locator and clicks with options', async () => {
    const locator = makeLocator();
    const page = makePage({ getByTestId: vi.fn(() => locator) as never });
    const { ctx } = makeCtx({ page });

    await runStep(click, ctx, {
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

    await runStep(dblclick, ctx, {
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

    await runStep(fill, ctx, {
      locator: { label: 'Email' },
      value: 'a@b.test',
      timeout: 5_000,
    });

    expect(locator.fill).toHaveBeenCalledWith('a@b.test', expect.objectContaining({ timeout: 5_000 }));
  });

  it('type clears with select-all + Backspace, not fill(empty)', async () => {
    // clear used to call fill(''), which is exactly the call a rich
    // contentEditable editor ignores: the old text stayed put and the
    // typed text appended to it. Select-all + Backspace works on both a
    // native input and a contentEditable.
    const locator = makeLocator();
    const page = makePage({ getByPlaceholder: vi.fn(() => locator) as never });
    const { ctx } = makeCtx({ page });

    await runStep(type, ctx, {
      locator: { placeholder: 'Search' },
      text: 'hello',
      delay: 0,
      clear: true,
      timeout: 5_000,
    });

    expect(locator.fill).not.toHaveBeenCalled();
    expect(page.keyboard.press).toHaveBeenCalledWith('ControlOrMeta+a');
    expect(page.keyboard.press).toHaveBeenCalledWith('Backspace');
    expect(locator.type).toHaveBeenCalledWith('hello', expect.objectContaining({ delay: 0 }));
  });

  it('insertText commits through the keyboard and clicks the target first', async () => {
    // Draft.js keys its edit mode off a native click-sourced focus
    // event, so focus() alone leaves the editor inert and any submit
    // button downstream stays disabled no matter what was typed.
    const locator = makeLocator();
    const page = makePage({ getByTestId: vi.fn(() => locator) as never });
    const { ctx } = makeCtx({ page });

    const result = await runStep(insertText, ctx, {
      locator: { testid: 'tweetTextarea_0' },
      text: 'hello world',
    });

    expect(locator.click).toHaveBeenCalled();
    expect(locator.fill).not.toHaveBeenCalled();
    expect(page.keyboard.insertText).toHaveBeenCalledWith('hello world');
    expect((result.output as { locatorIndex: number }).locatorIndex).toBe(0);
  });

  it('insertText works with no locator, against whatever holds focus', async () => {
    const page = makePage();
    const { ctx } = makeCtx({ page });

    const result = await runStep(insertText, ctx, { text: 'typed' });

    expect(page.keyboard.insertText).toHaveBeenCalledWith('typed');
    expect((result.output as { locatorIndex: number | null }).locatorIndex).toBeNull();
  });

  it('press uses locator.press when locator given, keyboard.press otherwise', async () => {
    const locator = makeLocator();
    const page = makePage({ getByRole: vi.fn(() => locator) as never });
    const { ctx } = makeCtx({ page });

    await runStep(press, ctx, {
      key: 'Enter',
      locator: { role: 'textbox' },
      delay: 0,
    });
    expect(locator.press).toHaveBeenCalledWith('Enter', expect.any(Object));

    await runStep(press, ctx, { key: 'Escape', delay: 0 });
    expect(page.keyboard.press).toHaveBeenCalledWith('Escape', expect.any(Object));
  });

  it('hover, focus, blur, scrollIntoViewIfNeeded delegate to the locator', async () => {
    const locator = makeLocator();
    const page = makePage({ locator: vi.fn(() => locator) as never });
    const { ctx } = makeCtx({ page });

    await runStep(hover, ctx, { locator: { selector: '.h' }, force: false, timeout: 5_000 });
    await runStep(focus, ctx, { locator: { selector: '.h' }, timeout: 5_000 });
    await runStep(blur, ctx, { locator: { selector: '.h' }, timeout: 5_000 });
    await runStep(scrollIntoViewIfNeeded, ctx, {
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

    await runStep(dragTo, ctx, {
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

    const result = await runStep(selectOption, ctx, {
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

    await runStep(check, ctx, { locator: { selector: 'input.box' }, state: true, timeout: 5_000 });
    expect(locator.check).toHaveBeenCalled();

    await runStep(check, ctx, { locator: { selector: 'input.box' }, state: false, timeout: 5_000 });
    expect(locator.uncheck).toHaveBeenCalled();
  });

  it('setInputFiles decodes base64 and forwards to the locator', async () => {
    const locator = makeLocator();
    const page = makePage({ getByTestId: vi.fn(() => locator) as never });
    const { ctx } = makeCtx({ page });
    const payload = Buffer.from('hello').toString('base64');

    const result = await runStep(setInputFiles, ctx, {
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
