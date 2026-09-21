import { z } from 'zod';
import { LocatorSpec, type LocatorCandidate, resolveLocatorOrFirst } from './locator.js';

type Candidates = LocatorCandidate[];
import type { StepExecutor, StepResult } from './types.js';

/**
 * `expect` is a single step that wraps every supported assertion. It is
 * a SCENARIO GUARD, not a test framework: when the assertion fails the
 * step returns `ok: false` so the runner marks it Failed and respects
 * `continueOnError` like any other step.
 *
 * Locator-bound assertions (toBeVisible, toHaveText, ...) require a
 * locator block. Page-level assertions (toHaveURL, toHaveTitle) read
 * straight off the page.
 */

const LocatorAssertion = z.enum([
  'toBeVisible',
  'toBeHidden',
  'toBeEnabled',
  'toBeDisabled',
  'toBeChecked',
  'toHaveText',
  'toContainText',
  'toHaveValue',
  'toHaveAttribute',
  'toHaveCount',
]);

const PageAssertion = z.enum(['toHaveURL', 'toHaveTitle']);

const Assertion = z.union([LocatorAssertion, PageAssertion]);

const TimeoutMs = z.number().int().positive().max(120_000);

type LocatorAssertionName = z.infer<typeof LocatorAssertion>;
type PageAssertionName = z.infer<typeof PageAssertion>;

export const expect: StepExecutor = {
  name: 'expect',
  description: 'Assert a scenario guard: visibility, text, count, URL, title, or attribute.',
  schema: z
    .object({
      assertion: Assertion,
      locator: LocatorSpec.optional(),
      value: z.unknown().optional(),
      regex: z.boolean().default(false),
      timeout: TimeoutMs.default(5_000),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as {
      assertion: LocatorAssertionName | PageAssertionName;
      locator?: Candidates;
      value?: unknown;
      regex: boolean;
      timeout: number;
    };

    if (PageAssertion.options.includes(c.assertion as PageAssertionName)) {
      return runPageAssertion(ctx.page, c.assertion as PageAssertionName, c.value, c.regex, c.timeout);
    }

    if (c.locator === undefined) {
      return { ok: false, error: `expect: ${c.assertion} requires a locator` };
    }

    // resolveLocatorOrFirst, not resolveLocator: toBeHidden is
    // satisfied BY nothing matching, so throwing on an empty page
    // would fail the assertion it should have passed. The assertion
    // owns its own timeout and its own opinion about absence.
    const target = await resolveLocatorOrFirst(ctx.page, c.locator);

    return runLocatorAssertion(
      target.locator,
      c.assertion as LocatorAssertionName,
      c.value,
      c.timeout,
    );
  },
};

async function runPageAssertion(
  page: import('patchright').Page,
  assertion: PageAssertionName,
  value: unknown,
  regex: boolean,
  timeout: number,
): Promise<StepResult> {
  const deadline = Date.now() + timeout;
  const expected = typeof value === 'string' ? value : '';

  while (Date.now() < deadline) {
    // `page.url()` answers from the client side and keeps answering over a
    // dead browser, so toHaveURL would poll its whole timeout where
    // toHaveTitle throws on the first call. Both end the same way now.
    let actual: string;

    try {
      actual = assertion === 'toHaveURL' ? page.url() : await page.title();
    } catch (error) {
      if (isBrowserGone(error)) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 100));

      continue;
    }

    const matched = regex ? new RegExp(expected).test(actual) : actual === expected;

    if (matched) {
      return { ok: true, output: { assertion, actual } };
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return {
    ok: false,
    error: `expect ${assertion} timed out; actual=${assertion === 'toHaveURL' ? page.url() : await page.title()}`,
  };
}

async function runLocatorAssertion(
  locator: import('patchright').Locator,
  assertion: LocatorAssertionName,
  value: unknown,
  timeout: number,
): Promise<StepResult> {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    try {
      const passed = await checkAssertion(locator, assertion, value);
      if (passed) {
        return { ok: true, output: { assertion } };
      }
    } catch (error) {
      // A locator not there yet throws too, and that one is worth polling
      // through. A browser that is gone is not: swallowed, it spent the
      // whole timeout and answered "timed out" with a 200, which a caller
      // cannot tell from a disabled button.
      if (isBrowserGone(error)) {
        throw error;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return { ok: false, error: `expect ${assertion} timed out` };
}

async function checkAssertion(
  locator: import('patchright').Locator,
  assertion: LocatorAssertionName,
  value: unknown,
): Promise<boolean> {
  switch (assertion) {
    case 'toBeVisible':
      return locator.isVisible();
    case 'toBeHidden':
      return !(await locator.isVisible());
    case 'toBeEnabled':
      return locator.isEnabled();
    case 'toBeDisabled':
      return locator.isDisabled();
    case 'toBeChecked':
      return locator.isChecked();
    case 'toHaveText':
      return (await locator.innerText()) === String(value ?? '');
    case 'toContainText':
      return (await locator.innerText()).includes(String(value ?? ''));
    case 'toHaveValue':
      return (await locator.inputValue()) === String(value ?? '');
    case 'toHaveAttribute': {
      const spec = (value ?? {}) as { name?: string; value?: string };
      if (typeof spec.name !== 'string') return false;
      const got = await locator.getAttribute(spec.name);
      return got === (spec.value ?? null);
    }
    case 'toHaveCount':
      return (await locator.count()) === Number(value ?? 0);
  }
}

/**
 * Whether an error means the page, its context or the whole browser is gone.
 *
 * Matched on playwright's own sentence, which is also what the caller keys
 * its browser-lost handling on.
 */
function isBrowserGone(error: unknown): boolean {
  return error instanceof Error && /Target page, context or browser has been closed/.test(error.message);
}
