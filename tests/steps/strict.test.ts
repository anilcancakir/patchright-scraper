import { describe, expect, it } from 'vitest';
import { goto } from '../../src/steps/navigation.js';
import { click, fill } from '../../src/steps/input.js';
import { content, screenshot } from '../../src/steps/inspection.js';
import { scrollBy } from '../../src/steps/scroll.js';
import { expect as expectStep } from '../../src/steps/expect.js';

/**
 * Pins the strict-mode contract: every step schema rejects unknown keys
 * so the PHP AutomationClient gets a loud ZodError instead of a silent
 * default-fall-through. The audit-followups regression target.
 */
describe('step schemas reject unknown keys', () => {
  it('goto rejects an unknown key', () => {
    const result = goto.schema.safeParse({
      url: 'https://example.org/',
      waitUntil: 'load',
      extra: 1,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.code === 'unrecognized_keys')).toBe(true);
    }
  });

  it('click rejects an unknown key', () => {
    const result = click.schema.safeParse({
      locator: { selector: '#go' },
      dx: 5,
    });

    expect(result.success).toBe(false);
  });

  it('fill rejects an unknown key', () => {
    const result = fill.schema.safeParse({
      locator: { testid: 'email' },
      value: 'a@b.test',
      extra: 1,
    });

    expect(result.success).toBe(false);
  });

  it('content rejects an unknown key', () => {
    const result = content.schema.safeParse({ extra: 1 });

    expect(result.success).toBe(false);
  });

  it('scrollBy rejects an unknown key (the audit case)', () => {
    const result = scrollBy.schema.safeParse({ x: 0, y: 0, dx: 50, dy: 50 });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.code === 'unrecognized_keys')).toBe(true);
    }
  });

  it('valid keys still pass', () => {
    expect(goto.schema.safeParse({ url: 'https://example.org/', waitUntil: 'load' }).success).toBe(
      true,
    );
    expect(scrollBy.schema.safeParse({ x: 0, y: 100 }).success).toBe(true);
    expect(
      click.schema.safeParse({ locator: { selector: '.a' } }).success,
    ).toBe(true);
    expect(
      expectStep.schema.safeParse({ assertion: 'toBeVisible', locator: { testid: 'x' } }).success,
    ).toBe(true);
    expect(
      screenshot.schema.safeParse({ mode: 'viewport', encoding: 'base64' }).success,
    ).toBe(true);
  });
});
