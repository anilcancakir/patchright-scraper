import { describe, expect, it } from 'vitest';
import { check, click, press_key, select_option, type_text, upload_file } from '../../src/steps/input.js';
import { makeCtx } from './_helpers.js';

describe('input primitives', () => {
  it('click clicks with the given selector + button', async () => {
    const { ctx, page } = makeCtx();

    await click.execute(ctx, {
      selector: 'a.cta',
      timeout_ms: 5_000,
      force: false,
      button: 'left',
      click_count: 1,
    });

    expect(page.click).toHaveBeenCalledWith('a.cta', expect.objectContaining({ button: 'left', clickCount: 1 }));
  });

  it('type_text fills empty first when clear=true', async () => {
    const { ctx, page } = makeCtx();

    await type_text.execute(ctx, {
      selector: 'input[name=q]',
      text: 'hello',
      delay_ms: 0,
      clear: true,
      timeout_ms: 5_000,
    });

    expect(page.fill).toHaveBeenCalledWith('input[name=q]', '', expect.any(Object));
    expect(page.type).toHaveBeenCalledWith('input[name=q]', 'hello', expect.objectContaining({ delay: 0 }));
  });

  it('press_key uses page.press when selector given, keyboard.press otherwise', async () => {
    const { ctx, page } = makeCtx();

    await press_key.execute(ctx, { key: 'Enter', selector: 'form input', delay_ms: 0 });
    expect(page.press).toHaveBeenCalledWith('form input', 'Enter', expect.any(Object));

    await press_key.execute(ctx, { key: 'Escape', delay_ms: 0 });
    expect(page.keyboard.press).toHaveBeenCalledWith('Escape', expect.any(Object));
  });

  it('select_option returns the selected values', async () => {
    const { ctx, page } = makeCtx();
    page.selectOption.mockResolvedValueOnce(['tr']);

    const result = await select_option.execute(ctx, { selector: 'select#country', values: ['tr'], timeout_ms: 5_000 });

    expect(result.ok).toBe(true);
    expect((result.output as { selected: string[] }).selected).toEqual(['tr']);
  });

  it('check toggles based on state', async () => {
    const { ctx, page } = makeCtx();

    await check.execute(ctx, { selector: 'input.box', state: true, timeout_ms: 5_000 });
    expect(page.check).toHaveBeenCalledWith('input.box', expect.any(Object));

    await check.execute(ctx, { selector: 'input.box', state: false, timeout_ms: 5_000 });
    expect(page.uncheck).toHaveBeenCalledWith('input.box', expect.any(Object));
  });

  it('upload_file decodes base64 into setInputFiles', async () => {
    const { ctx, page } = makeCtx();
    const payload = Buffer.from('hello').toString('base64');

    const result = await upload_file.execute(ctx, {
      selector: 'input[type=file]',
      source: 'base64',
      payload,
      filename: 'demo.txt',
      mime_type: 'text/plain',
      timeout_ms: 5_000,
    });

    expect(page.setInputFiles).toHaveBeenCalled();
    const args = page.setInputFiles.mock.calls[0]!;
    expect(args[0]).toBe('input[type=file]');
    expect((args[1] as { name: string }).name).toBe('demo.txt');
    expect(result.ok).toBe(true);
    expect((result.output as { bytes: number }).bytes).toBe(5);
  });
});
