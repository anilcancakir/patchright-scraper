import { vi } from 'vitest';
import type { StepContext, StepExecutor, StepResult } from '../../src/steps/types.js';

/**
 * Run a step the way the router runs it: config through the executor's
 * own schema first, parsed output into execute().
 *
 * Calling execute() with a raw object skips every default and every
 * transform the schema declares, so a test written that way asserts
 * against a shape production never sees. That is not hypothetical: the
 * locator field normalises a single candidate into a one-element list
 * on parse, and tests bypassing it were handing execute() an object
 * where it expects an array.
 */
export async function runStep(
  executor: StepExecutor,
  ctx: StepContext,
  config: unknown,
): Promise<StepResult> {
  const parsed = executor.schema.safeParse(config);

  if (!parsed.success) {
    throw new Error(
      `step "${executor.name}" rejected its config: ${JSON.stringify(parsed.error.issues)}`,
    );
  }

  return executor.execute(ctx, parsed.data);
}

export interface MockLocator {
  click: ReturnType<typeof vi.fn>;
  dblclick: ReturnType<typeof vi.fn>;
  fill: ReturnType<typeof vi.fn>;
  type: ReturnType<typeof vi.fn>;
  press: ReturnType<typeof vi.fn>;
  hover: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  blur: ReturnType<typeof vi.fn>;
  dragTo: ReturnType<typeof vi.fn>;
  scrollIntoViewIfNeeded: ReturnType<typeof vi.fn>;
  selectOption: ReturnType<typeof vi.fn>;
  check: ReturnType<typeof vi.fn>;
  uncheck: ReturnType<typeof vi.fn>;
  setInputFiles: ReturnType<typeof vi.fn>;
  innerText: ReturnType<typeof vi.fn>;
  inputValue: ReturnType<typeof vi.fn>;
  getAttribute: ReturnType<typeof vi.fn>;
  isVisible: ReturnType<typeof vi.fn>;
  isEnabled: ReturnType<typeof vi.fn>;
  isDisabled: ReturnType<typeof vi.fn>;
  isChecked: ReturnType<typeof vi.fn>;
  count: ReturnType<typeof vi.fn>;
  evaluate: ReturnType<typeof vi.fn>;
  screenshot: ReturnType<typeof vi.fn>;
  waitFor: ReturnType<typeof vi.fn>;
}

export function makeLocator(overrides: Partial<MockLocator> = {}): MockLocator {
  return {
    click: vi.fn(async () => undefined),
    dblclick: vi.fn(async () => undefined),
    fill: vi.fn(async () => undefined),
    type: vi.fn(async () => undefined),
    press: vi.fn(async () => undefined),
    hover: vi.fn(async () => undefined),
    focus: vi.fn(async () => undefined),
    blur: vi.fn(async () => undefined),
    dragTo: vi.fn(async () => undefined),
    scrollIntoViewIfNeeded: vi.fn(async () => undefined),
    selectOption: vi.fn(async () => ['ok']),
    check: vi.fn(async () => undefined),
    uncheck: vi.fn(async () => undefined),
    setInputFiles: vi.fn(async () => undefined),
    innerText: vi.fn(async () => ''),
    inputValue: vi.fn(async () => ''),
    getAttribute: vi.fn(async () => null),
    isVisible: vi.fn(async () => true),
    isEnabled: vi.fn(async () => true),
    isDisabled: vi.fn(async () => false),
    isChecked: vi.fn(async () => false),
    count: vi.fn(async () => 1),
    evaluate: vi.fn(async () => undefined),
    screenshot: vi.fn(async () => Buffer.from([])),
    waitFor: vi.fn(async () => undefined),
    ...overrides,
  };
}

export interface MockPage {
  url: ReturnType<typeof vi.fn>;
  goto: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  goBack: ReturnType<typeof vi.fn>;
  goForward: ReturnType<typeof vi.fn>;
  waitForSelector: ReturnType<typeof vi.fn>;
  waitForLoadState: ReturnType<typeof vi.fn>;
  waitForURL: ReturnType<typeof vi.fn>;
  waitForFunction: ReturnType<typeof vi.fn>;
  keyboard: {
    press: ReturnType<typeof vi.fn>;
    insertText: ReturnType<typeof vi.fn>;
  };
  screenshot: ReturnType<typeof vi.fn>;
  content: ReturnType<typeof vi.fn>;
  title: ReturnType<typeof vi.fn>;
  evaluate: ReturnType<typeof vi.fn>;
  setViewportSize: ReturnType<typeof vi.fn>;
  locator: ReturnType<typeof vi.fn>;
  getByRole: ReturnType<typeof vi.fn>;
  getByText: ReturnType<typeof vi.fn>;
  getByLabel: ReturnType<typeof vi.fn>;
  getByPlaceholder: ReturnType<typeof vi.fn>;
  getByTestId: ReturnType<typeof vi.fn>;
  getByAltText: ReturnType<typeof vi.fn>;
  getByTitle: ReturnType<typeof vi.fn>;
}

export interface MockContext {
  setExtraHTTPHeaders: ReturnType<typeof vi.fn>;
  setOffline: ReturnType<typeof vi.fn>;
  setGeolocation: ReturnType<typeof vi.fn>;
  grantPermissions: ReturnType<typeof vi.fn>;
  route: ReturnType<typeof vi.fn>;
}

export function makePage(overrides: Partial<MockPage> = {}): MockPage {
  const sharedLocator = makeLocator();
  const locatorFactory = vi.fn(() => sharedLocator);

  return {
    url: vi.fn(() => 'https://example.org/'),
    goto: vi.fn(async () => ({ status: () => 200 })),
    reload: vi.fn(async () => ({ status: () => 200 })),
    goBack: vi.fn(async () => null),
    goForward: vi.fn(async () => null),
    waitForSelector: vi.fn(async () => sharedLocator),
    waitForLoadState: vi.fn(async () => undefined),
    waitForURL: vi.fn(async () => undefined),
    waitForFunction: vi.fn(async () => null),
    keyboard: {
      press: vi.fn(async () => undefined),
      insertText: vi.fn(async () => undefined),
    },
    screenshot: vi.fn(async () => Buffer.from('IMG')),
    content: vi.fn(async () => '<html></html>'),
    title: vi.fn(async () => 'Page'),
    evaluate: vi.fn(async () => undefined),
    setViewportSize: vi.fn(async () => undefined),
    locator: locatorFactory,
    getByRole: locatorFactory,
    getByText: locatorFactory,
    getByLabel: locatorFactory,
    getByPlaceholder: locatorFactory,
    getByTestId: locatorFactory,
    getByAltText: locatorFactory,
    getByTitle: locatorFactory,
    ...overrides,
  };
}

export function makeContext(overrides: Partial<MockContext> = {}): MockContext {
  return {
    setExtraHTTPHeaders: vi.fn(async () => undefined),
    setOffline: vi.fn(async () => undefined),
    setGeolocation: vi.fn(async () => undefined),
    grantPermissions: vi.fn(async () => undefined),
    route: vi.fn(async () => undefined),
    ...overrides,
  };
}

export function makeCtx(
  overrides: { page?: MockPage; context?: MockContext } = {},
): { ctx: StepContext; page: MockPage; context: MockContext } {
  const page = overrides.page ?? makePage();
  const context = overrides.context ?? makeContext();
  const ctx: StepContext = {
    page: page as never,
    context: context as never,
    sessionId: 'test-session',
    log: () => undefined,
  };
  return { ctx, page, context };
}
