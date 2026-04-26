import { describe, expect, it } from 'vitest';
import { goto, wait_for } from '../../src/steps/navigation.js';
import { click } from '../../src/steps/input.js';
import { html } from '../../src/steps/inspection.js';
import { scroll_by } from '../../src/steps/scroll.js';

/**
 * Pins the strict-mode contract for every step schema. Phase 2 of the
 * audit-followups plan turns silent typo passes (where unknown keys
 * silently fell through to defaults) into a clean ZodError so the
 * PHP AutomationClient gets a loud signal instead of a no-op.
 */
describe('step schemas reject unknown keys', () => {
  it('goto rejects an unknown key', () => {
    const result = goto.schema.safeParse({ url: 'https://example.org/', wait_until: 'load', extra: 1 });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.code === 'unrecognized_keys')).toBe(true);
    }
  });

  it('wait_for rejects an unknown key inside the load_state branch', () => {
    const result = wait_for.schema.safeParse({ mode: 'load_state', state: 'load', extra: 1 });

    expect(result.success).toBe(false);
  });

  it('click rejects an unknown key', () => {
    const result = click.schema.safeParse({ selector: '#go', dx: 5 });

    expect(result.success).toBe(false);
  });

  it('html rejects an unknown key', () => {
    const result = html.schema.safeParse({ extra: 1 });

    expect(result.success).toBe(false);
  });

  it('scroll_by rejects an unknown key (the audit case)', () => {
    const result = scroll_by.schema.safeParse({ x: 0, y: 0, dx: 50, dy: 50 });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.code === 'unrecognized_keys')).toBe(true);
    }
  });

  it('valid keys still pass', () => {
    expect(goto.schema.safeParse({ url: 'https://example.org/', wait_until: 'load' }).success).toBe(true);
    expect(scroll_by.schema.safeParse({ x: 0, y: 100 }).success).toBe(true);
  });
});
