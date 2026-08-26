import type { Locator, Page } from 'patchright';
import { z } from 'zod';

/**
 * Locator block contract. Every step that targets an element accepts a
 * `locator` object with exactly ONE variant key. Mirrors Playwright's
 * built-in `getBy*` family one-to-one so anyone fluent in Playwright can
 * author scenarios without translation.
 *
 * Mutual exclusivity is enforced by `.refine()` on top of the union;
 * a single matching variant is required, multi-variant or empty objects
 * are rejected at validation time.
 */

/**
 * Optional disambiguator for any locator variant. Mirrors Playwright's
 * `.nth(n)` chain: `nth=0` selects the first match, `nth=2` the third,
 * and so on. Without it, Playwright runs in strict mode and throws when
 * a locator matches multiple elements.
 */
const NthModifier = z.number().int().nonnegative().optional();

export const SelectorLocator = z
  .object({
    selector: z.string().min(1),
    nth: NthModifier,
  })
  .strict();

export const RoleLocator = z
  .object({
    role: z.string().min(1),
    name: z.string().optional(),
    exact: z.boolean().optional(),
    nth: NthModifier,
  })
  .strict();

export const TextLocator = z
  .object({
    text: z.string().min(1),
    exact: z.boolean().optional(),
    nth: NthModifier,
  })
  .strict();

export const LabelLocator = z
  .object({
    label: z.string().min(1),
    exact: z.boolean().optional(),
    nth: NthModifier,
  })
  .strict();

export const PlaceholderLocator = z
  .object({
    placeholder: z.string().min(1),
    exact: z.boolean().optional(),
    nth: NthModifier,
  })
  .strict();

export const TestIdLocator = z
  .object({
    testid: z.string().min(1),
    nth: NthModifier,
  })
  .strict();

export const AltTextLocator = z
  .object({
    alttext: z.string().min(1),
    exact: z.boolean().optional(),
    nth: NthModifier,
  })
  .strict();

export const TitleLocator = z
  .object({
    title: z.string().min(1),
    exact: z.boolean().optional(),
    nth: NthModifier,
  })
  .strict();

/**
 * Disjoint union over every supported locator variant. Each variant has
 * a unique discriminator key so the union is unambiguous on parse.
 */
export const LocatorCandidateSpec = z.union([
  SelectorLocator,
  RoleLocator,
  TextLocator,
  LabelLocator,
  PlaceholderLocator,
  TestIdLocator,
  AltTextLocator,
  TitleLocator,
]);

export type LocatorCandidate = z.infer<typeof LocatorCandidateSpec>;

/**
 * What a step's `locator` field accepts on the wire.
 *
 * Either one candidate (every recipe written before chains existed) or
 * an ordered list of them, normalised to a list by the transform so
 * exactly one shape reaches {@link resolveLocator}. Accepting both is
 * not a compatibility shim: a recipe targeting a stable element has no
 * use for a fallback, and forcing it to write a one-element array would
 * be noise.
 *
 * The list is ordered by preference, not by likelihood. The first
 * candidate that matches wins, so candidate 0 should be the one the
 * recipe author actually means and the rest are what to reach for when
 * the site moves under it.
 */
export const LocatorSpec = z
  .union([LocatorCandidateSpec, z.array(LocatorCandidateSpec).min(1)])
  .transform((value): LocatorCandidate[] => (Array.isArray(value) ? value : [value]));

export type LocatorSpec = z.infer<typeof LocatorSpec>;

/** A matched locator plus which candidate produced it. */
export interface ResolvedLocator {
  locator: Locator;
  /** Index into the candidate list. 0 means the preferred one matched. */
  index: number;
  /** Milliseconds left of the resolution budget, for the action to spend. */
  remainingMs: number;
}

/** No candidate matched inside the budget. */
export class LocatorUnresolvedError extends Error {
  constructor(candidates: LocatorCandidate[], timeout: number) {
    super(
      `No locator candidate matched within ${timeout}ms. Tried: ${JSON.stringify(candidates)}`,
    );
    this.name = 'LocatorUnresolvedError';
  }
}

const SWEEP_INTERVAL_MS = 100;

/**
 * Resolve the first candidate that matches exactly one element.
 *
 * Resolution polls `count()` rather than attempting the action, and it
 * does so against ONE shared budget. Attempting each candidate in turn
 * would multiply the step's timeout by the number of candidates, which
 * on a three-candidate chain with the default 10s turns one missing
 * element into half a minute of dead wall clock.
 *
 * A candidate matching more than one element without an `nth` is
 * REJECTED rather than accepted. Playwright strict mode would throw on
 * the subsequent action, so taking it would skip the working fallback
 * and then fail anyway, which is the worst of both.
 *
 * `count()` does not auto-wait, so the sweep is what waits: candidates
 * are re-checked every 100ms until one matches or the budget runs out.
 * Whatever is left of the budget goes to the caller, so a chain cannot
 * spend the resolution budget and then a fresh action timeout on top.
 */
export async function resolveLocator(
  page: Page,
  candidates: LocatorCandidate[],
  timeout: number,
): Promise<ResolvedLocator> {
  const startedAt = Date.now();
  const deadline = startedAt + timeout;

  for (;;) {
    for (const [index, candidate] of candidates.entries()) {
      const match = await matchCandidate(page, candidate);

      if (match === null) {
        continue;
      }

      return {
        locator: match,
        index,
        remainingMs: Math.max(0, deadline - Date.now()),
      };
    }

    if (Date.now() >= deadline) {
      throw new LocatorUnresolvedError(candidates, timeout);
    }

    await new Promise((resolve) => setTimeout(resolve, SWEEP_INTERVAL_MS));
  }
}

/**
 * One candidate against the page right now. Null when it matches
 * nothing, and null when it matches several without an `nth` to pick
 * one: strict mode would throw on the action, so taking it would skip a
 * working fallback and then fail anyway.
 */
async function matchCandidate(page: Page, candidate: LocatorCandidate): Promise<Locator | null> {
  const base = baseLocator(page, candidate);
  const nth = candidate.nth;
  const count = await base.count();

  if (count === 0) {
    return null;
  }

  if (count > 1 && typeof nth !== 'number') {
    return null;
  }

  return typeof nth === 'number' ? base.nth(nth) : base;
}

/**
 * Resolve for a step that has its own waiting and its own opinion about
 * absence: `expect` and `waitForSelector`.
 *
 * One sweep, no polling, and no throw. Those steps assert about a state
 * the element may legitimately not be in yet, and two of their modes
 * (`toBeHidden`, `state: 'hidden'`) are satisfied precisely BY nothing
 * matching, so a resolver that threw on an empty page would turn a
 * passing assertion into an error. Falling back to candidate 0 hands the
 * step a locator to assert against and lets its own timeout do the
 * waiting, which is exactly what a single-candidate spec did before
 * chains existed.
 */
export async function resolveLocatorOrFirst(
  page: Page,
  candidates: LocatorCandidate[],
): Promise<ResolvedLocator> {
  for (const [index, candidate] of candidates.entries()) {
    const match = await matchCandidate(page, candidate);

    if (match !== null) {
      return { locator: match, index, remainingMs: 0 };
    }
  }

  // Nothing on the page right now. Hand back the preferred candidate so
  // the step asserts against what the author meant; an absence assertion
  // passes and a presence assertion fails with Playwright's own message
  // naming that selector, rather than ours naming all of them.
  const first = candidates[0];

  if (first === undefined) {
    throw new LocatorUnresolvedError(candidates, 0);
  }

  const base = baseLocator(page, first);
  const nth = first.nth;

  return {
    locator: typeof nth === 'number' ? base.nth(nth) : base,
    index: 0,
    remainingMs: 0,
  };
}

function baseLocator(page: Page, spec: LocatorCandidate): Locator {
  if ('selector' in spec) {
    return page.locator(spec.selector);
  }

  if ('role' in spec) {
    // Playwright's role typing accepts a closed enum; passing the spec
    // string straight through is safe because the runtime helper accepts
    // any ARIA role and surfaces a clear error otherwise.
    return page.getByRole(spec.role as Parameters<Page['getByRole']>[0], {
      name: spec.name,
      exact: spec.exact,
    });
  }

  if ('text' in spec) {
    return page.getByText(spec.text, { exact: spec.exact });
  }

  if ('label' in spec) {
    return page.getByLabel(spec.label, { exact: spec.exact });
  }

  if ('placeholder' in spec) {
    return page.getByPlaceholder(spec.placeholder, { exact: spec.exact });
  }

  if ('testid' in spec) {
    return page.getByTestId(spec.testid);
  }

  if ('alttext' in spec) {
    return page.getByAltText(spec.alttext, { exact: spec.exact });
  }

  return page.getByTitle(spec.title, { exact: spec.exact });
}
