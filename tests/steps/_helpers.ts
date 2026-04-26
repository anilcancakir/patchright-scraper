import { vi } from 'vitest';
import type { StepContext } from '../../src/steps/types.js';

export interface MockPage {
  url: ReturnType<typeof vi.fn>;
  goto: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  goBack: ReturnType<typeof vi.fn>;
  waitForSelector: ReturnType<typeof vi.fn>;
  waitForLoadState: ReturnType<typeof vi.fn>;
  click: ReturnType<typeof vi.fn>;
  type: ReturnType<typeof vi.fn>;
  fill: ReturnType<typeof vi.fn>;
  press: ReturnType<typeof vi.fn>;
  keyboard: { press: ReturnType<typeof vi.fn> };
  selectOption: ReturnType<typeof vi.fn>;
  check: ReturnType<typeof vi.fn>;
  uncheck: ReturnType<typeof vi.fn>;
  setInputFiles: ReturnType<typeof vi.fn>;
  screenshot: ReturnType<typeof vi.fn>;
  content: ReturnType<typeof vi.fn>;
  evaluate: ReturnType<typeof vi.fn>;
  setViewportSize: ReturnType<typeof vi.fn>;
}

export interface MockHandle {
  evaluate: ReturnType<typeof vi.fn>;
  innerText: ReturnType<typeof vi.fn>;
  getAttribute: ReturnType<typeof vi.fn>;
  screenshot: ReturnType<typeof vi.fn>;
}

export function makeHandle(overrides: Partial<MockHandle> = {}): MockHandle {
  return {
    evaluate: vi.fn(async () => undefined),
    innerText: vi.fn(async () => ''),
    getAttribute: vi.fn(async () => null),
    screenshot: vi.fn(async () => Buffer.from([])),
    ...overrides,
  };
}

export function makePage(overrides: Partial<MockPage> = {}): MockPage {
  const handle = makeHandle();
  return {
    url: vi.fn(() => 'https://example.org/'),
    goto: vi.fn(async () => ({ status: () => 200 })),
    reload: vi.fn(async () => ({ status: () => 200 })),
    goBack: vi.fn(async () => null),
    waitForSelector: vi.fn(async () => handle),
    waitForLoadState: vi.fn(async () => undefined),
    click: vi.fn(async () => undefined),
    type: vi.fn(async () => undefined),
    fill: vi.fn(async () => undefined),
    press: vi.fn(async () => undefined),
    keyboard: { press: vi.fn(async () => undefined) },
    selectOption: vi.fn(async () => ['ok']),
    check: vi.fn(async () => undefined),
    uncheck: vi.fn(async () => undefined),
    setInputFiles: vi.fn(async () => undefined),
    screenshot: vi.fn(async () => Buffer.from('IMG')),
    content: vi.fn(async () => '<html></html>'),
    evaluate: vi.fn(async () => undefined),
    setViewportSize: vi.fn(async () => undefined),
    ...overrides,
  };
}

export function makeCtx(overrides: { page?: MockPage } = {}): { ctx: StepContext; page: MockPage } {
  const page = overrides.page ?? makePage();
  const ctx: StepContext = {
    page: page as never,
    context: {} as never,
    sessionId: 'test-session',
    log: () => undefined,
  };
  return { ctx, page };
}
