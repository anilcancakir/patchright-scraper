import { mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { LocatorSpec, resolveLocator } from './locator.js';
import type { StepExecutor } from './types.js';

const TimeoutMs = z.number().int().positive().max(120_000);

export const click: StepExecutor = {
  name: 'click',
  description: 'Click an element matched by a locator.',
  schema: z
    .object({
      locator: LocatorSpec,
      button: z.enum(['left', 'right', 'middle']).default('left'),
      clickCount: z.number().int().positive().default(1),
      delay: z.number().int().nonnegative().default(0),
      force: z.boolean().default(false),
      timeout: TimeoutMs.default(10_000),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as {
      locator: LocatorSpec;
      button: 'left' | 'right' | 'middle';
      clickCount: number;
      delay: number;
      force: boolean;
      timeout: number;
    };
    await resolveLocator(ctx.page, c.locator).click({
      button: c.button,
      clickCount: c.clickCount,
      delay: c.delay,
      force: c.force,
      timeout: c.timeout,
    });

    return { ok: true, output: { clicked: true } };
  },
};

export const dblclick: StepExecutor = {
  name: 'dblclick',
  description: 'Double-click an element matched by a locator.',
  schema: z
    .object({
      locator: LocatorSpec,
      button: z.enum(['left', 'right', 'middle']).default('left'),
      delay: z.number().int().nonnegative().default(0),
      force: z.boolean().default(false),
      timeout: TimeoutMs.default(10_000),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as {
      locator: LocatorSpec;
      button: 'left' | 'right' | 'middle';
      delay: number;
      force: boolean;
      timeout: number;
    };
    await resolveLocator(ctx.page, c.locator).dblclick({
      button: c.button,
      delay: c.delay,
      force: c.force,
      timeout: c.timeout,
    });

    return { ok: true, output: { clicked: true } };
  },
};

export const fill: StepExecutor = {
  name: 'fill',
  description: 'Fill an input/textarea instantly (no per-character delay).',
  schema: z
    .object({
      locator: LocatorSpec,
      value: z.string(),
      timeout: TimeoutMs.default(10_000),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as { locator: LocatorSpec; value: string; timeout: number };
    await resolveLocator(ctx.page, c.locator).fill(c.value, { timeout: c.timeout });

    return { ok: true, output: { length: c.value.length } };
  },
};

export const type: StepExecutor = {
  name: 'type',
  description: 'Type text character-by-character with optional per-key delay.',
  schema: z
    .object({
      locator: LocatorSpec,
      text: z.string(),
      delay: z.number().int().nonnegative().default(0),
      clear: z.boolean().default(false),
      timeout: TimeoutMs.default(10_000),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as {
      locator: LocatorSpec;
      text: string;
      delay: number;
      clear: boolean;
      timeout: number;
    };
    const target = resolveLocator(ctx.page, c.locator);

    if (c.clear) {
      await target.fill('', { timeout: c.timeout });
    }
    await target.type(c.text, { delay: c.delay, timeout: c.timeout });

    return { ok: true, output: { length: c.text.length } };
  },
};

export const press: StepExecutor = {
  name: 'press',
  description: 'Press a single keyboard key, optionally focused on an element first.',
  schema: z
    .object({
      key: z.string().min(1),
      locator: LocatorSpec.optional(),
      delay: z.number().int().nonnegative().default(0),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as { key: string; locator?: LocatorSpec; delay: number };

    if (c.locator !== undefined) {
      await resolveLocator(ctx.page, c.locator).press(c.key, { delay: c.delay });
    } else {
      await ctx.page.keyboard.press(c.key, { delay: c.delay });
    }

    return { ok: true, output: { key: c.key } };
  },
};

export const hover: StepExecutor = {
  name: 'hover',
  description: 'Hover the cursor over an element matched by a locator.',
  schema: z
    .object({
      locator: LocatorSpec,
      force: z.boolean().default(false),
      timeout: TimeoutMs.default(10_000),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as { locator: LocatorSpec; force: boolean; timeout: number };
    await resolveLocator(ctx.page, c.locator).hover({ force: c.force, timeout: c.timeout });

    return { ok: true, output: { hovered: true } };
  },
};

export const focus: StepExecutor = {
  name: 'focus',
  description: 'Focus an element matched by a locator.',
  schema: z
    .object({
      locator: LocatorSpec,
      timeout: TimeoutMs.default(10_000),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as { locator: LocatorSpec; timeout: number };
    await resolveLocator(ctx.page, c.locator).focus({ timeout: c.timeout });

    return { ok: true, output: { focused: true } };
  },
};

export const blur: StepExecutor = {
  name: 'blur',
  description: 'Blur an element matched by a locator.',
  schema: z
    .object({
      locator: LocatorSpec,
      timeout: TimeoutMs.default(10_000),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as { locator: LocatorSpec; timeout: number };
    await resolveLocator(ctx.page, c.locator).blur({ timeout: c.timeout });

    return { ok: true, output: { blurred: true } };
  },
};

export const dragTo: StepExecutor = {
  name: 'dragTo',
  description: 'Drag the source element to the target element.',
  schema: z
    .object({
      locator: LocatorSpec,
      target: LocatorSpec,
      force: z.boolean().default(false),
      timeout: TimeoutMs.default(10_000),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as {
      locator: LocatorSpec;
      target: LocatorSpec;
      force: boolean;
      timeout: number;
    };
    await resolveLocator(ctx.page, c.locator).dragTo(resolveLocator(ctx.page, c.target), {
      force: c.force,
      timeout: c.timeout,
    });

    return { ok: true, output: { dragged: true } };
  },
};

export const scrollIntoViewIfNeeded: StepExecutor = {
  name: 'scrollIntoViewIfNeeded',
  description: 'Scroll the element into view if it is not already.',
  schema: z
    .object({
      locator: LocatorSpec,
      timeout: TimeoutMs.default(10_000),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as { locator: LocatorSpec; timeout: number };
    await resolveLocator(ctx.page, c.locator).scrollIntoViewIfNeeded({ timeout: c.timeout });

    return { ok: true, output: { scrolled: true } };
  },
};

export const selectOption: StepExecutor = {
  name: 'selectOption',
  description: 'Select one or more options on a <select> element.',
  schema: z
    .object({
      locator: LocatorSpec,
      values: z.array(z.string()).min(1),
      timeout: TimeoutMs.default(10_000),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as { locator: LocatorSpec; values: string[]; timeout: number };
    const selected = await resolveLocator(ctx.page, c.locator).selectOption(c.values, {
      timeout: c.timeout,
    });

    return { ok: true, output: { selected } };
  },
};

export const check: StepExecutor = {
  name: 'check',
  description: 'Toggle a checkbox or radio input to the desired state.',
  schema: z
    .object({
      locator: LocatorSpec,
      state: z.boolean().default(true),
      timeout: TimeoutMs.default(10_000),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as { locator: LocatorSpec; state: boolean; timeout: number };
    const target = resolveLocator(ctx.page, c.locator);

    if (c.state) {
      await target.check({ timeout: c.timeout });
    } else {
      await target.uncheck({ timeout: c.timeout });
    }

    return { ok: true, output: { state: c.state } };
  },
};

export const setInputFiles: StepExecutor = {
  name: 'setInputFiles',
  description: 'Attach a base64-encoded file or remote URL to an <input type=file>.',
  schema: z
    .object({
      locator: LocatorSpec,
      source: z.enum(['base64', 'url']),
      payload: z.string(),
      filename: z.string(),
      mimeType: z.string().default('application/octet-stream'),
      timeout: TimeoutMs.default(30_000),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as {
      locator: LocatorSpec;
      source: 'base64' | 'url';
      payload: string;
      filename: string;
      mimeType: string;
      timeout: number;
    };

    let buffer: Buffer;
    if (c.source === 'base64') {
      buffer = Buffer.from(c.payload, 'base64');
    } else {
      const response = await fetch(c.payload, { signal: AbortSignal.timeout(c.timeout) });
      if (!response.ok) {
        return { ok: false, error: `setInputFiles: fetch failed ${response.status}` };
      }
      buffer = Buffer.from(await response.arrayBuffer());
    }

    const dir = mkdtempSync(join(tmpdir(), 'patchright-upload-'));
    const tmpFile = join(dir, c.filename);
    writeFileSync(tmpFile, buffer);

    try {
      await resolveLocator(ctx.page, c.locator).setInputFiles({
        name: c.filename,
        mimeType: c.mimeType,
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
