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
    expect(((descriptors[0].schema as { properties?: Record<string, unknown> }).properties ?? {}).foo).toBeDefined();
  });
});

describe('boot-time registration', () => {
  afterEach(() => {
    stepRegistry.reset();
  });

  it('registers all 22 built-in primitives', async () => {
    // Importing index triggers the boot-time register loop.
    await import('../../src/steps/index.js');

    const names = stepRegistry.list();

    const expected = [
      'attribute',
      'check',
      'click',
      'evaluate_named',
      'extract_dom_named',
      'go_back',
      'goto',
      'html',
      'press_key',
      'reload',
      'screenshot',
      'scroll_by',
      'scroll_modal',
      'scroll_to',
      'scroll_until_plateau',
      'select_option',
      'set_user_agent',
      'set_viewport',
      'text',
      'type_text',
      'upload_file',
      'wait_for',
    ];

    expect(names).toEqual(expected);
  });
});
