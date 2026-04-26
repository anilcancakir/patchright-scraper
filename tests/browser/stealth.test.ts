import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  applyStealthInjections,
  resolveFingerprintProfile,
  resolveStealthFlags,
} from '../../src/browser/stealth.js';

describe('resolveFingerprintProfile', () => {
  it('returns undefined when no profile env is set', () => {
    expect(resolveFingerprintProfile({})).toBeUndefined();
  });

  it('returns the desktop profile by name', () => {
    const profile = resolveFingerprintProfile({ FINGERPRINT_PROFILE: 'desktop' });
    expect(profile?.locale).toBe('en-US');
    expect(profile?.viewport?.width).toBe(1920);
  });

  it('returns the mobile-tr profile with Turkish locale', () => {
    const profile = resolveFingerprintProfile({ FINGERPRINT_PROFILE: 'mobile-tr' });
    expect(profile?.locale).toBe('tr-TR');
    expect(profile?.timezoneId).toBe('Europe/Istanbul');
  });

  it('prefers FINGERPRINT_PROFILE_FILE over the built-in name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fp-'));
    const path = join(dir, 'custom.json');
    writeFileSync(path, JSON.stringify({ userAgent: 'CustomUA/1.0', locale: 'fr-FR' }));

    const profile = resolveFingerprintProfile({ FINGERPRINT_PROFILE: 'desktop', FINGERPRINT_PROFILE_FILE: path });
    expect(profile?.userAgent).toBe('CustomUA/1.0');
    expect(profile?.locale).toBe('fr-FR');
  });
});

describe('resolveStealthFlags', () => {
  it('returns no extra flags by default', () => {
    expect(resolveStealthFlags({})).toEqual([]);
    expect(resolveStealthFlags({ PATCHRIGHT_STEALTH_LEVEL: 'basic' })).toEqual([]);
  });

  it('returns aggressive flags when requested', () => {
    expect(resolveStealthFlags({ PATCHRIGHT_STEALTH_LEVEL: 'aggressive' })).toContain('--disable-blink-features=AutomationControlled');
  });
});

describe('applyStealthInjections', () => {
  it('returns 0 when the inject dir does not exist', async () => {
    const fakeContext = { addInitScript: vi.fn(async () => undefined) };
    const count = await applyStealthInjections(fakeContext as never, { JS_INJECTIONS_DIR: '/path/that/does/not/exist' });
    expect(count).toBe(0);
    expect(fakeContext.addInitScript).not.toHaveBeenCalled();
  });

  it('injects every *.js file from the directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'inject-'));
    writeFileSync(join(dir, 'one.js'), 'window.A = 1;');
    writeFileSync(join(dir, 'two.js'), 'window.B = 2;');
    writeFileSync(join(dir, 'three.txt'), 'ignored');

    const fakeContext = { addInitScript: vi.fn(async () => undefined) };
    const count = await applyStealthInjections(fakeContext as never, { JS_INJECTIONS_DIR: dir });

    expect(count).toBe(2);
    expect(fakeContext.addInitScript).toHaveBeenCalledTimes(2);
  });
});
