import { mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { LocatorSpec, type LocatorCandidate, resolveLocator } from './locator.js';
import type { StepExecutor } from './types.js';

const TimeoutMs = z.number().int().positive().max(120_000);

/**
 * Locator candidates arrive normalised to a list by LocatorSpec's
 * transform, so every step reads the same shape whether the recipe
 * wrote one object or a fallback chain.
 */
type Candidates = LocatorCandidate[];

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
      locator: Candidates;
      button: 'left' | 'right' | 'middle';
      clickCount: number;
      delay: number;
      force: boolean;
      timeout: number;
    };
    const target = await resolveLocator(ctx.page, c.locator, c.timeout);
    await target.locator.click({
      button: c.button,
      clickCount: c.clickCount,
      delay: c.delay,
      force: c.force,
      timeout: target.remainingMs,
    });

    return { ok: true, output: { clicked: true, locatorIndex: target.index } };
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
      locator: Candidates;
      button: 'left' | 'right' | 'middle';
      delay: number;
      force: boolean;
      timeout: number;
    };
    const target = await resolveLocator(ctx.page, c.locator, c.timeout);
    await target.locator.dblclick({
      button: c.button,
      delay: c.delay,
      force: c.force,
      timeout: target.remainingMs,
    });

    return { ok: true, output: { clicked: true, locatorIndex: target.index } };
  },
};

export const fill: StepExecutor = {
  name: 'fill',
  description:
    'Fill a native input/textarea instantly. Does NOT work on rich contentEditable editors (Draft.js, Lexical, ProseMirror); use insertText there.',
  schema: z
    .object({
      locator: LocatorSpec,
      value: z.string(),
      timeout: TimeoutMs.default(10_000),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as { locator: Candidates; value: string; timeout: number };
    const target = await resolveLocator(ctx.page, c.locator, c.timeout);
    await target.locator.fill(c.value, { timeout: target.remainingMs });

    return { ok: true, output: { length: c.value.length, locatorIndex: target.index } };
  },
};

export const insertText: StepExecutor = {
  name: 'insertText',
  description:
    'Commit text into the focused element the way an IME does. The reliable way into rich contentEditable editors that ignore fill().',
  schema: z
    .object({
      locator: LocatorSpec.optional(),
      text: z.string(),
      clear: z.boolean().default(false),
      timeout: TimeoutMs.default(10_000),
    })
    .strict(),
  /**
   * `keyboard.insertText` maps to CDP `Input.insertText`, which commits
   * the whole string as a single composition event rather than
   * synthesising per-character keydowns.
   *
   * Two reasons that matters. Rich editors built on `beforeinput`
   * (Draft.js, Lexical, ProseMirror) ignore `fill()` entirely because it
   * sets a value no controlled component reads. And per-character typing
   * races the editor's own mount: the first characters land before the
   * handler is listening and vanish, which reads like a flaky selector.
   *
   * When a locator is supplied it is CLICKED, not focused. A rich editor
   * keys its edit mode off a native click-sourced focus event, so
   * `focus()` alone leaves it inert and any submit button downstream
   * stays disabled no matter what was typed.
   */
  async execute(ctx, config) {
    const c = config as {
      locator?: Candidates;
      text: string;
      clear: boolean;
      timeout: number;
    };

    let locatorIndex: number | null = null;

    if (c.locator !== undefined) {
      const target = await resolveLocator(ctx.page, c.locator, c.timeout);
      await target.locator.click({ timeout: target.remainingMs });
      locatorIndex = target.index;
    }

    if (c.clear) {
      // Select-all + Backspace rather than fill(''), which is the exact
      // call a contentEditable editor ignores. Both modifiers are sent
      // because the container is Linux and an operator recording a
      // recipe on macOS would otherwise write one that only works there.
      await ctx.page.keyboard.press('ControlOrMeta+a');
      await ctx.page.keyboard.press('Backspace');
    }

    await ctx.page.keyboard.insertText(c.text);

    return { ok: true, output: { length: c.text.length, locatorIndex } };
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
      locator: Candidates;
      text: string;
      delay: number;
      clear: boolean;
      timeout: number;
    };
    const target = await resolveLocator(ctx.page, c.locator, c.timeout);

    if (c.clear) {
      // Was fill(''), which silently does nothing on a contentEditable
      // and left the old text in place for the typed text to append to.
      await target.locator.click({ timeout: target.remainingMs });
      await ctx.page.keyboard.press('ControlOrMeta+a');
      await ctx.page.keyboard.press('Backspace');
    }

    await target.locator.type(c.text, { delay: c.delay, timeout: target.remainingMs });

    return { ok: true, output: { length: c.text.length, locatorIndex: target.index } };
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
      timeout: TimeoutMs.default(10_000),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as {
      key: string;
      locator?: Candidates;
      delay: number;
      timeout: number;
    };

    if (c.locator !== undefined) {
      const target = await resolveLocator(ctx.page, c.locator, c.timeout);
      await target.locator.press(c.key, { delay: c.delay, timeout: target.remainingMs });

      return { ok: true, output: { key: c.key, locatorIndex: target.index } };
    }

    await ctx.page.keyboard.press(c.key, { delay: c.delay });

    return { ok: true, output: { key: c.key, locatorIndex: null } };
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
    const c = config as { locator: Candidates; force: boolean; timeout: number };
    const target = await resolveLocator(ctx.page, c.locator, c.timeout);
    await target.locator.hover({ force: c.force, timeout: target.remainingMs });

    return { ok: true, output: { hovered: true, locatorIndex: target.index } };
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
    const c = config as { locator: Candidates; timeout: number };
    const target = await resolveLocator(ctx.page, c.locator, c.timeout);
    await target.locator.focus({ timeout: target.remainingMs });

    return { ok: true, output: { focused: true, locatorIndex: target.index } };
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
    const c = config as { locator: Candidates; timeout: number };
    const target = await resolveLocator(ctx.page, c.locator, c.timeout);
    await target.locator.blur({ timeout: target.remainingMs });

    return { ok: true, output: { blurred: true, locatorIndex: target.index } };
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
      locator: Candidates;
      target: Candidates;
      force: boolean;
      timeout: number;
    };
    const source = await resolveLocator(ctx.page, c.locator, c.timeout);
    const destination = await resolveLocator(ctx.page, c.target, source.remainingMs);

    await source.locator.dragTo(destination.locator, {
      force: c.force,
      timeout: destination.remainingMs,
    });

    return {
      ok: true,
      output: {
        dragged: true,
        locatorIndex: source.index,
        targetLocatorIndex: destination.index,
      },
    };
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
    const c = config as { locator: Candidates; timeout: number };
    const target = await resolveLocator(ctx.page, c.locator, c.timeout);
    await target.locator.scrollIntoViewIfNeeded({ timeout: target.remainingMs });

    return { ok: true, output: { scrolled: true, locatorIndex: target.index } };
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
    const c = config as { locator: Candidates; values: string[]; timeout: number };
    const target = await resolveLocator(ctx.page, c.locator, c.timeout);
    const selected = await target.locator.selectOption(c.values, {
      timeout: target.remainingMs,
    });

    return { ok: true, output: { selected, locatorIndex: target.index } };
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
    const c = config as { locator: Candidates; state: boolean; timeout: number };
    const target = await resolveLocator(ctx.page, c.locator, c.timeout);

    if (c.state) {
      await target.locator.check({ timeout: target.remainingMs });
    } else {
      await target.locator.uncheck({ timeout: target.remainingMs });
    }

    return { ok: true, output: { state: c.state, locatorIndex: target.index } };
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
      locator: Candidates;
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

    const target = await resolveLocator(ctx.page, c.locator, c.timeout);

    try {
      await target.locator.setInputFiles({
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

    return {
      ok: true,
      output: { filename: c.filename, bytes: buffer.byteLength, locatorIndex: target.index },
    };
  },
};
