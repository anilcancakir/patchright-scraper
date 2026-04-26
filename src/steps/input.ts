import { z } from 'zod';
import { mkdtempSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StepExecutor } from './types.js';

export const click: StepExecutor = {
  name: 'click',
  schema: z.object({
    selector: z.string(),
    timeout_ms: z.number().int().positive().default(10_000),
    force: z.boolean().default(false),
    button: z.enum(['left', 'right', 'middle']).default('left'),
    click_count: z.number().int().positive().default(1),
  }),
  async execute(ctx, config) {
    const c = config as { selector: string; timeout_ms: number; force: boolean; button: 'left' | 'right' | 'middle'; click_count: number };
    await ctx.page.click(c.selector, {
      timeout: c.timeout_ms,
      force: c.force,
      button: c.button,
      clickCount: c.click_count,
    });
    return { ok: true, output: { selector: c.selector } };
  },
};

export const type_text: StepExecutor = {
  name: 'type_text',
  schema: z.object({
    selector: z.string(),
    text: z.string(),
    delay_ms: z.number().int().nonnegative().default(0),
    clear: z.boolean().default(false),
    timeout_ms: z.number().int().positive().default(10_000),
  }),
  async execute(ctx, config) {
    const c = config as { selector: string; text: string; delay_ms: number; clear: boolean; timeout_ms: number };

    if (c.clear) {
      await ctx.page.fill(c.selector, '', { timeout: c.timeout_ms });
    }

    // Use type() rather than fill() so per-character delay can mimic
    // human pacing when the target element refuses programmatic fill.
    await ctx.page.type(c.selector, c.text, { delay: c.delay_ms, timeout: c.timeout_ms });
    return { ok: true, output: { length: c.text.length } };
  },
};

export const press_key: StepExecutor = {
  name: 'press_key',
  schema: z.object({
    key: z.string(),
    selector: z.string().optional(),
    delay_ms: z.number().int().nonnegative().default(0),
  }),
  async execute(ctx, config) {
    const c = config as { key: string; selector?: string; delay_ms: number };

    if (c.selector !== undefined) {
      await ctx.page.press(c.selector, c.key, { delay: c.delay_ms });
    } else {
      await ctx.page.keyboard.press(c.key, { delay: c.delay_ms });
    }
    return { ok: true, output: { key: c.key } };
  },
};

export const select_option: StepExecutor = {
  name: 'select_option',
  schema: z.object({
    selector: z.string(),
    values: z.array(z.string()).min(1),
    timeout_ms: z.number().int().positive().default(10_000),
  }),
  async execute(ctx, config) {
    const c = config as { selector: string; values: string[]; timeout_ms: number };
    const selected = await ctx.page.selectOption(c.selector, c.values, { timeout: c.timeout_ms });
    return { ok: true, output: { selected } };
  },
};

export const check: StepExecutor = {
  name: 'check',
  schema: z.object({
    selector: z.string(),
    state: z.boolean().default(true),
    timeout_ms: z.number().int().positive().default(10_000),
  }),
  async execute(ctx, config) {
    const c = config as { selector: string; state: boolean; timeout_ms: number };

    if (c.state) {
      await ctx.page.check(c.selector, { timeout: c.timeout_ms });
    } else {
      await ctx.page.uncheck(c.selector, { timeout: c.timeout_ms });
    }
    return { ok: true, output: { state: c.state } };
  },
};

export const upload_file: StepExecutor = {
  name: 'upload_file',
  schema: z.object({
    selector: z.string(),
    source: z.enum(['base64', 'url']),
    payload: z.string(),
    filename: z.string(),
    mime_type: z.string().default('application/octet-stream'),
    timeout_ms: z.number().int().positive().default(30_000),
  }),
  async execute(ctx, config) {
    const c = config as { selector: string; source: 'base64' | 'url'; payload: string; filename: string; mime_type: string; timeout_ms: number };

    let buffer: Buffer;
    if (c.source === 'base64') {
      buffer = Buffer.from(c.payload, 'base64');
    } else {
      const response = await fetch(c.payload, { signal: AbortSignal.timeout(c.timeout_ms) });
      if (!response.ok) {
        return { ok: false, error: `upload_file: fetch failed ${response.status}` };
      }
      buffer = Buffer.from(await response.arrayBuffer());
    }

    // Stream to a tmp file so memory does not balloon for large uploads;
    // unlink afterwards regardless of outcome.
    const dir = mkdtempSync(join(tmpdir(), 'patchright-upload-'));
    const tmpFile = join(dir, c.filename);
    writeFileSync(tmpFile, buffer);

    try {
      await ctx.page.setInputFiles(c.selector, {
        name: c.filename,
        mimeType: c.mime_type,
        buffer,
      });
    } finally {
      try {
        unlinkSync(tmpFile);
      } catch {
        // ignore tmp cleanup errors
      }
    }

    return { ok: true, output: { filename: c.filename, bytes: buffer.byteLength } };
  },
};
