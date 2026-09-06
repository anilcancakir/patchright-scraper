import { z } from 'zod';
import { sampleKeystrokeGap } from './input.js';
import type { StepExecutor } from './types.js';

const TimeoutMs = z.number().int().positive().max(120_000);

export const scrollBy: StepExecutor = {
  name: 'scrollBy',
  description: 'Scroll the page by a pixel offset.',
  schema: z
    .object({
      x: z.number().default(0),
      y: z.number().default(0),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as { x: number; y: number };
    await ctx.page.evaluate(({ x, y }) => window.scrollBy(x, y), { x: c.x, y: c.y });

    return { ok: true, output: { x: c.x, y: c.y } };
  },
};

export const scrollUntilPlateau: StepExecutor = {
  name: 'scrollUntilPlateau',
  description: 'Scroll repeatedly until the page or container height stops growing.',
  schema: z
    .object({
      selector: z.string().optional(),
      maxIterations: z.number().int().positive().default(20),
      settleMs: z.number().int().nonnegative().default(750),
      plateauIterations: z.number().int().positive().default(2),
      stepPx: z.number().int().positive().default(1200),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as {
      selector?: string;
      maxIterations: number;
      settleMs: number;
      plateauIterations: number;
      stepPx: number;
    };

    let lastHeight = -1;
    let plateauHits = 0;
    let iterations = 0;

    for (; iterations < c.maxIterations; iterations++) {
      const height = await ctx.page.evaluate(
        ({ selector, stepPx }) => {
          const target = selector
            ? (document.querySelector(selector) as HTMLElement | null)
            : null;

          if (target) {
            target.scrollBy({ top: stepPx });
            return target.scrollHeight;
          }

          window.scrollBy({ top: stepPx });
          return document.documentElement.scrollHeight;
        },
        { selector: c.selector, stepPx: c.stepPx },
      );

      await new Promise((resolve) => setTimeout(resolve, c.settleMs));

      if (height === lastHeight) {
        plateauHits += 1;
        if (plateauHits >= c.plateauIterations) {
          return {
            ok: true,
            output: { iterations: iterations + 1, finalHeight: height, plateau: true },
          };
        }
      } else {
        plateauHits = 0;
        lastHeight = height;
      }
    }

    return { ok: true, output: { iterations, finalHeight: lastHeight, plateau: false } };
  },
};

export const scrollModal: StepExecutor = {
  name: 'scrollModal',
  description: 'Scroll inside a modal until its inner content stops growing.',
  schema: z
    .object({
      modalSelector: z.string().min(1),
      scrollSelector: z.string().optional(),
      maxIterations: z.number().int().positive().default(15),
      settleMs: z.number().int().nonnegative().default(500),
      stepPx: z.number().int().positive().default(800),
      timeout: TimeoutMs.default(10_000),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as {
      modalSelector: string;
      scrollSelector?: string;
      maxIterations: number;
      settleMs: number;
      stepPx: number;
      timeout: number;
    };

    await ctx.page.waitForSelector(c.modalSelector, { timeout: c.timeout });

    const target = c.scrollSelector ?? c.modalSelector;
    let lastHeight = -1;

    for (let i = 0; i < c.maxIterations; i++) {
      const height = await ctx.page.evaluate(
        ({ selector, stepPx }) => {
          const el = document.querySelector(selector) as HTMLElement | null;
          if (el === null) return -1;
          el.scrollBy({ top: stepPx });
          return el.scrollHeight;
        },
        { selector: target, stepPx: c.stepPx },
      );

      await new Promise((resolve) => setTimeout(resolve, c.settleMs));

      if (height === -1) {
        return { ok: false, error: `scrollModal: selector lost ${target}` };
      }

      if (height === lastHeight) {
        return { ok: true, output: { iterations: i + 1, finalHeight: height, plateau: true } };
      }
      lastHeight = height;
    }

    return {
      ok: true,
      output: { iterations: c.maxIterations, finalHeight: lastHeight, plateau: false },
    };
  },
};

/**
 * One scroll delta, in pixels.
 *
 * The uniform version of this was a signature. Every pass moved exactly
 * `stepPx` and waited exactly `settleMs`, so a sweep over a timeline
 * produced a column of identical deltas at identical intervals: a shape
 * no hand produces, on a site that reads pointer and wheel behaviour.
 * It is the same tell this codebase already removed from typing, left in
 * place on the one step whose whole job is to look like someone reading.
 *
 * Drawn from the same lognormal the keystroke gap uses. A wheel notch is
 * quantised and a trackpad flick is not, so real deltas are neither
 * constant nor normally distributed: they cluster near a comfortable
 * scroll with a long tail for the occasional hard flick, which is what
 * a right-skewed draw gives.
 *
 * Floored at a third of the nominal step. A draw small enough to move
 * almost nothing would waste a pass and, on a virtualized list, could
 * unmount nothing new and trip the idle counter early.
 */
function sampleScrollDelta(stepPx: number): number {
  return Math.max(Math.round(stepPx / 3), Math.round(sampleKeystrokeGap(stepPx)));
}

/**
 * A small, plausible resting place for the pointer over a feed.
 *
 * Absolute rather than relative, because nothing here tracks where the
 * pointer is and the hover step in front of the collector has already
 * put it over the column. Drawn inside the middle of a 1920x1080
 * viewport: far enough from the edges to be over content on any of the
 * layouts these recipes read, and varied enough that twenty wheel events
 * do not share one coordinate.
 */
function pointerDrift(): { x: number; y: number } {
  return {
    x: 700 + Math.round(Math.random() * 420),
    y: 380 + Math.round(Math.random() * 300),
  };
}

export const scrollAndCollect: StepExecutor = {
  name: 'scrollAndCollect',
  description:
    'Scroll a virtualized list, harvesting rows on every pass and deduping by a key attribute. Use instead of scroll-then-extractDom wherever rows unmount as they leave the viewport.',
  schema: z
    .object({
      name: z.string().min(1),
      selector: z.string().min(1),
      keySelector: z.string().min(1).optional(),
      keyAttribute: z.string().min(1).default('href'),
      keyField: z.string().min(1).default('key'),
      keyResolve: z.boolean().default(false),
      fields: z
        .record(
          z.string().min(1),
          z
            .object({
              selector: z.string().min(1).optional(),
              attr: z.string().min(1).optional(),
            })
            .strict(),
        )
        .default({}),
      attrs: z.array(z.string()).default([]),
      includeText: z.boolean().default(true),
      container: z.string().min(1).optional(),
      maxIterations: z.number().int().positive().default(20),
      maxRows: z.number().int().positive().default(500),
      minRows: z.number().int().nonnegative().default(0),
      requiredFields: z.array(z.string().min(1)).default([]),
      settleMs: z.number().int().nonnegative().default(750),
      idleIterations: z.number().int().positive().default(2),
      stepPx: z.number().int().positive().default(1200),
    })
    .strict(),
  /**
   * `extractDom` reads what is mounted RIGHT NOW. On a virtualized list
   * (react-window and friends) rows are removed from the DOM as they
   * leave the viewport, so scrolling to the bottom and then extracting
   * returns the last screenful and silently loses everything above it.
   * The loss is invisible: the step succeeds and the output looks like a
   * short list rather than a broken one.
   *
   * So harvest on every pass and merge, keyed on something stable per
   * row. The key is what makes this safe to run repeatedly: without it,
   * re-reading the same rows after a short scroll would duplicate them.
   *
   * Termination is `idleIterations` consecutive passes that add no new
   * key, not a scroll-height plateau. A virtualized container keeps its
   * scrollHeight roughly constant by design (spacer divs stand in for
   * the unmounted rows), so height is not a signal about progress here.
   *
   * `fields` is how a row becomes data rather than a screenshot in text
   * form. Without it the only text available is the row's own innerText,
   * which on an X card is author, handle, "14m", "Replying to", the body
   * and the engagement counts run together in one string that no caller
   * can take apart. Each entry names where to read from
   * (`selector`, omitted for the row itself) and what to read
   * (`attr`, omitted for innerText), which is one primitive rather than
   * two: an author's name is text, a permalink is an attribute of a
   * descendant, and both are wanted from the same row.
   *
   * `keyField` returns the dedupe key instead of throwing it away. It is
   * already computed, and for every X recipe it is the post's own
   * permalink, so discarding it left the whole system unable to name a
   * post it had just read.
   *
   * `keyResolve` decides whether that value is the raw attribute
   * (`/user/status/123`, a path) or the browser's own resolution of it
   * (an absolute URL). Off by default, because the raw attribute is what
   * every stored recipe already reads; on, a caller can hand the value
   * straight back to an action that takes a URL instead of knowing to
   * prepend a host.
   *
   * `minRows` exists because this step could not fail. A row whose key
   * resolves to null is skipped silently, so if the permalink markup ever
   * moves, every row is skipped, the idle counter trips and the step
   * returns an empty list with `ok: true`. The `waitForSelector` in front
   * still passes, because the articles are there. The run then reports
   * success with zero results and nothing anywhere says the recipe
   * rotted.
   *
   * `requiredFields` closes the same hole one level down. A field whose
   * selector misses is written as null, so a moved body selector returned
   * a full count of rows that were all `{"body": null}`: `minRows` counts
   * rows, not content, and was satisfied. Naming a field here drops the
   * rows that lack it, which turns a moved selector back into an empty
   * result and therefore into a `minRows` failure.
   */
  async execute(ctx, config) {
    const c = config as {
      name: string;
      selector: string;
      keySelector?: string;
      keyAttribute: string;
      keyField: string;
      keyResolve: boolean;
      fields: Record<string, { selector?: string; attr?: string }>;
      attrs: string[];
      includeText: boolean;
      container?: string;
      maxIterations: number;
      maxRows: number;
      minRows: number;
      requiredFields: string[];
      settleMs: number;
      idleIterations: number;
      stepPx: number;
    };

    const collected = new Map<string, Record<string, string | null>>();
    let idleHits = 0;
    let iterations = 0;

    for (; iterations < c.maxIterations; iterations += 1) {
      const batch = await ctx.page.evaluate(
        ({ selector, keySelector, keyAttribute, keyResolve, fields, attrs, includeText }) => {
          const rows: Array<{ key: string; row: Record<string, string | null> }> = [];

          for (const el of Array.from(document.querySelectorAll(selector))) {
            const keyEl = keySelector ? el.querySelector(keySelector) : el;

            // `.href` on an anchor is the browser's own resolution of the
            // attribute against the document base, so an `/a/status/1`
            // becomes the absolute URL a caller can hand straight back to
            // an action that takes one. The raw attribute stays the
            // default: it is what every stored recipe already reads.
            const resolvable =
              keyResolve && keyAttribute === 'href' && keyEl instanceof HTMLAnchorElement;
            const key = (resolvable ? keyEl.href : keyEl?.getAttribute(keyAttribute)) ?? null;

            if (key === null || key === '') {
              continue;
            }

            const row: Record<string, string | null> = {};
            for (const attr of attrs) {
              row[attr] = el.getAttribute(attr);
            }
            if (includeText) {
              row.text = (el as HTMLElement).innerText ?? null;
            }

            // `querySelector` has no strict mode and returns the first
            // match, which is what makes this safe on a site that renders
            // every layout twice: the second copy is simply not read.
            for (const [name, spec] of Object.entries(fields)) {
              const target = spec.selector ? el.querySelector(spec.selector) : el;

              if (target === null) {
                row[name] = null;
                continue;
              }

              row[name] = spec.attr
                ? target.getAttribute(spec.attr)
                : ((target as HTMLElement).innerText ?? null);
            }

            rows.push({ key, row });
          }

          return rows;
        },
        {
          selector: c.selector,
          keySelector: c.keySelector ?? null,
          keyAttribute: c.keyAttribute,
          keyResolve: c.keyResolve,
          fields: c.fields,
          attrs: c.attrs,
          includeText: c.includeText,
        },
      );

      const before = collected.size;

      for (const { key, row } of batch) {
        if (!collected.has(key)) {
          // Stamped here rather than in the page: the key is already
          // known on this side, so sending it in and reading it back out
          // would be a round trip for a value we are holding.
          collected.set(key, { ...row, [c.keyField]: key });
        }
      }

      if (collected.size >= c.maxRows) {
        break;
      }

      idleHits = collected.size === before ? idleHits + 1 : 0;

      if (idleHits >= c.idleIterations) {
        break;
      }

      const delta = sampleScrollDelta(c.stepPx);

      if (c.container) {
        // A named container still goes through the DOM: a wheel lands on
        // whatever is under the pointer, and nothing here knows where
        // that container is on screen.
        await ctx.page.evaluate(
          ({ container, stepPx }) => {
            const target = document.querySelector(container) as HTMLElement | null;
            target?.scrollBy({ top: stepPx });
          },
          { container: c.container, stepPx: delta },
        );
      } else {
        // A real wheel, not `window.scrollBy`. The DOM call emits no
        // `wheel` event at all and moves the whole distance in one frame,
        // so a page watching input sees a document that scrolled with
        // nobody scrolling it, and per-frame displacement no hand can
        // produce. `mouse.wheel` goes through CDP, so Chrome runs its own
        // smooth-scroll animation and emits the intermediate frames along
        // with the event itself.
        //
        // Nudge the pointer first. A wheel dispatches wherever the
        // pointer already is, and nothing in this loop moved it, so a
        // 25-row read emitted twenty wheel events at one identical
        // clientX/clientY over half a minute. A hand resting on a
        // trackpad drifts; a fixed coordinate through twenty events is
        // the same uniformity tell as the fixed delta was.
        const drift = pointerDrift();
        await ctx.page.mouse.move(drift.x, drift.y);
        await ctx.page.mouse.wheel(0, delta);
      }

      await new Promise((resolve) => setTimeout(resolve, sampleKeystrokeGap(c.settleMs)));
    }

    // Dropped, not failed. A single card that renders no body (a poll, a
    // deleted quote) is ordinary; a selector that has moved takes every
    // row with it and lands on `minRows` below, which is the loud half.
    const usable = Array.from(collected.values()).filter((row) =>
      c.requiredFields.every((name) => row[name] !== null && row[name] !== undefined && row[name] !== ''),
    );

    const rows = usable.slice(0, c.maxRows);

    if (rows.length < c.minRows) {
      return {
        ok: false,
        error:
          `scrollAndCollect: collected ${rows.length} rows of a required ${c.minRows} for `
          + `"${c.name}". ${iterations} passes over \`${c.selector}\`` +
          (c.keySelector ? `, keyed on \`${c.keySelector}\`@${c.keyAttribute}` : '') +
          '. A row whose key does not resolve is skipped, so this is what a moved permalink '
          + 'looks like from here rather than an empty page.',
      };
    }

    return {
      ok: true,
      output: {
        name: c.name,
        rows,
        iterations,
        // True when the sweep stopped because the list stopped growing
        // rather than because it hit a cap. A caller that asked for 500
        // rows and got exactly 500 with exhausted=false has more to read.
        exhausted: idleHits >= c.idleIterations,
      },
    };
  },
};
