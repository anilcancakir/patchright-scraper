import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { stepRegistry } from '../../src/steps/registry.js';
import type { StepExecutor } from '../../src/steps/types.js';

const fakeExecutor = (name: string): StepExecutor => ({
  name,
  schema: z.object({}),
  async execute() {
    return { ok: true };
  },
});

describe('stepRegistry', () => {
  afterEach(() => {
    stepRegistry.reset();
  });

  it('registers and looks up an executor by name', () => {
    const executor = fakeExecutor('demo');

    stepRegistry.register(executor);

    expect(stepRegistry.get('demo')).toBe(executor);
  });

  it('returns sorted names from list()', () => {
    stepRegistry.register(fakeExecutor('zeta'));
    stepRegistry.register(fakeExecutor('alpha'));

    expect(stepRegistry.list()).toEqual(['alpha', 'zeta']);
  });

  it('throws on duplicate name', () => {
    stepRegistry.register(fakeExecutor('dup'));

    expect(() => stepRegistry.register(fakeExecutor('dup'))).toThrow(/already registered/);
  });

  it('describe() returns name, description, and JSON schema for every executor', () => {
    stepRegistry.register({
      name: 'with_schema',
      description: 'demo step',
      schema: z.object({ foo: z.string() }).strict(),
      async execute() {
        return { ok: true };
      },
    });

    const descriptors = stepRegistry.describe();

    expect(descriptors).toHaveLength(1);
    expect(descriptors[0].name).toBe('with_schema');
    expect(descriptors[0].description).toBe('demo step');
    expect((descriptors[0].schema as Record<string, unknown>).type).toBe('object');
  });
});

describe('boot-time registration', () => {
  afterEach(() => {
    stepRegistry.reset();
  });

  it('registers every Playwright-shaped primitive', async () => {
    // Importing index triggers the boot-time register loop.
    await import('../../src/steps/index.js');

    const names = stepRegistry.list();

    const expectedSubset = [
      'goto',
      'goBack',
      'goForward',
      'reload',
      'click',
      'dblclick',
      'fill',
      'type',
      'press',
      'hover',
      'focus',
      'blur',
      'dragTo',
      'scrollIntoViewIfNeeded',
      'selectOption',
      'check',
      'setInputFiles',
      'screenshot',
      'content',
      'innerText',
      'getAttribute',
      'inputValue',
      'evaluate',
      'extractDom',
      'scrollBy',
      'scrollUntilPlateau',
      'scrollModal',
      'setViewportSize',
      'setUserAgent',
      'setExtraHTTPHeaders',
      'setOffline',
      'setGeolocation',
      'routeBlock',
      'waitForSelector',
      'waitForLoadState',
      'waitForTimeout',
      'waitForURL',
      'waitForFunction',
      'expect',
      'solveCaptcha',
    ];

    for (const name of expectedSubset) {
      expect(names, `step "${name}" should be registered`).toContain(name);
    }

    // Legacy snake_case names must NOT be registered any more.
    const legacy = [
      'wait_for',
      'go_back',
      'type_text',
      'press_key',
      'select_option',
      'set_viewport',
      'set_user_agent',
      'scroll_to',
      'scroll_by',
      'scroll_until_plateau',
      'scroll_modal',
      'extract_dom_named',
      'evaluate_named',
      'upload_file',
    ];
    for (const name of legacy) {
      expect(names, `legacy "${name}" should be gone`).not.toContain(name);
    }
  });
});
