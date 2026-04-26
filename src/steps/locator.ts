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

export const SelectorLocator = z
  .object({
    selector: z.string().min(1),
  })
  .strict();

export const RoleLocator = z
  .object({
    role: z.string().min(1),
    name: z.string().optional(),
    exact: z.boolean().optional(),
  })
  .strict();

export const TextLocator = z
  .object({
    text: z.string().min(1),
    exact: z.boolean().optional(),
  })
  .strict();

export const LabelLocator = z
  .object({
    label: z.string().min(1),
    exact: z.boolean().optional(),
  })
  .strict();

export const PlaceholderLocator = z
  .object({
    placeholder: z.string().min(1),
    exact: z.boolean().optional(),
  })
  .strict();

export const TestIdLocator = z
  .object({
    testid: z.string().min(1),
  })
  .strict();

export const AltTextLocator = z
  .object({
    alttext: z.string().min(1),
    exact: z.boolean().optional(),
  })
  .strict();

export const TitleLocator = z
  .object({
    title: z.string().min(1),
    exact: z.boolean().optional(),
  })
  .strict();

/**
 * Disjoint union over every supported locator variant. Each variant has
 * a unique discriminator key so the union is unambiguous on parse.
 */
export const LocatorSpec = z.union([
  SelectorLocator,
  RoleLocator,
  TextLocator,
  LabelLocator,
  PlaceholderLocator,
  TestIdLocator,
  AltTextLocator,
  TitleLocator,
]);

export type LocatorSpec = z.infer<typeof LocatorSpec>;

/**
 * Resolve a {@link LocatorSpec} into a Playwright {@link Locator} bound
 * to the supplied page. Each variant maps to its canonical Playwright
 * helper: `selector` to `page.locator(...)`, `role` to `page.getByRole`,
 * and so on. Roles and text honor Playwright's `exact` option.
 */
export function resolveLocator(page: Page, spec: LocatorSpec): Locator {
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
