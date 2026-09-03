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

/**
 * Default gap between keystrokes on the `type` step, in milliseconds.
 *
 * Was 0, which sent a 40-character field as 40 key events with no gap
 * between them. That is a behavioural signal independent of how each
 * event was dispatched, and it is the axis a 2026-09-03 CDP-versus-XTEST
 * measurement explicitly could not rule out: that A/B held provenance
 * constant across 180 trials, found no separation, and left timing as
 * the untested variable.
 *
 * A recipe that genuinely wants the old behaviour writes `delay: 0`,
 * which is treated as an explicit opt-out rather than as a tiny gap.
 */
export const KEYSTROKE_MEAN_MS = 100;

/**
 * How far a sampled gap may stray from the mean, as a fraction of it.
 *
 * The gap is sampled rather than fixed because a constant interval is
 * its own signal: nobody types at exactly 100ms. 0.4 puts a 100ms mean
 * in a 60 to 140ms band, which is inside the spread of ordinary human
 * typing rather than an attempt to model one person's rhythm.
 */
const KEYSTROKE_JITTER = 0.4;

/**
 * One inter-keystroke gap, in milliseconds.
 *
 * Exported for its own test: the property that matters (a band, and not
 * a constant) is worth pinning directly rather than inferring from
 * wall-clock timings inside a step test.
 */
export function sampleKeystrokeGap(mean: number): number {
  if (mean <= 0) {
    return 0;
  }

  const spread = mean * KEYSTROKE_JITTER;

  return Math.round(mean - spread + Math.random() * spread * 2);
}

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
      delay: z.number().int().nonnegative().default(KEYSTROKE_MEAN_MS),
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

    if (c.delay <= 0) {
      // Explicit opt-out. One call, one burst, no gaps, and Playwright
      // bounds the whole operation itself. pressSequentially rather than
      // the deprecated type(): same key events, same options, still
      // supported.
      await target.locator.pressSequentially(c.text, { delay: 0, timeout: target.remainingMs });

      return { ok: true, output: { length: c.text.length, locatorIndex: target.index } };
    }

    // Refuse up front rather than overrun. Playwright's own type() bounds
    // itself against the timeout; a hand-rolled loop does not, so a long
    // string at a human gap would hold the browser far past the declared
    // timeout. Both levers are named because either one fixes it and the
    // right choice depends on whether the text or the pace is the point.
    const projectedMs = c.text.length * c.delay;

    if (projectedMs > target.remainingMs) {
      throw new Error(
        `Typing ${c.text.length} characters at ~${c.delay}ms each needs about ${projectedMs}ms, ` +
          `but only ${target.remainingMs}ms of the step budget is left. ` +
          'Raise "timeout" or lower "delay" (0 types instantly).',
      );
    }

    await target.locator.focus({ timeout: target.remainingMs });

    // Per character, so the gap can be sampled between keys. keyboard.type
    // sends the real keydown/keypress/keyup triple for one character;
    // insertText would deliver the text with no key events at all.
    for (const char of c.text) {
      await ctx.page.keyboard.type(char);
      await new Promise((resolve) => setTimeout(resolve, sampleKeystrokeGap(c.delay)));
    }

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

/**
 * Fill a multi-part composer, adding each new part as it goes.
 *
 * A thread cannot be expressed as a static step list, because the number
 * of parts is an input and the scenario engine has no loop. It also
 * cannot be faked with `try_branch`: that catches a
 * ScenarioStepFailedException and cannot tell "there is no part 4" from
 * "the add button broke", so a five-part thread would quietly post as
 * two and report success. The whole reason for composing a thread in one
 * pass rather than as a reply chain is that it is all-or-nothing, and
 * swallowing a real failure gives that away.
 *
 * The ORDER here is measured, not assumed. On X the add control is only
 * present while the last part has content: it disappears the moment a
 * new empty part is created and returns once that part is typed into.
 * So each iteration types first and adds second, never two adds in a
 * row. Getting this backwards produces a recipe that works for two
 * parts and hangs on three.
 *
 * `editorTemplate` keeps the site's naming in the recipe where it can be
 * repaired without a release, while the loop lives here where it has to.
 * `{index}` is substituted per part (X names them tweetTextarea_0,
 * tweetTextarea_1, ...).
 *
 * Nothing is submitted. The recipe still owns the click that publishes,
 * so a caller can inspect or abandon a composed thread.
 */
export const composeThread: StepExecutor = {
  name: 'composeThread',
  description:
    'Type each part of a multi-part composer, clicking the add control between parts. Does not submit.',
  schema: z
    .object({
      editorTemplate: z.string().min(1),
      addButton: LocatorSpec,
      parts: z.array(z.string().min(1)).min(1).max(25),
      timeout: TimeoutMs.default(20_000),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as {
      editorTemplate: string;
      addButton: Candidates;
      parts: string[];
      timeout: number;
    };

    for (const [index, part] of c.parts.entries()) {
      if (index > 0) {
        const add = await resolveLocator(ctx.page, c.addButton, c.timeout);
        await add.locator.click({ timeout: add.remainingMs });
      }

      const selector = c.editorTemplate.replaceAll('{index}', String(index));
      const editor = await resolveLocator(ctx.page, [{ selector, nth: 0 }], c.timeout);

      // Clicked rather than focused, for the same reason insertText
      // clicks: a rich editor keys its edit mode off a real
      // click-sourced focus event and stays inert otherwise.
      await editor.locator.click({ timeout: editor.remainingMs });
      await ctx.page.keyboard.insertText(part);
    }

    return { ok: true, output: { parts: c.parts.length } };
  },
};
