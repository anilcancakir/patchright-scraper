import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clearSingletonGuards } from '../../src/session.js';

describe('clearSingletonGuards', () => {
  function profile(): string {
    const dir = mkdtempSync(join(tmpdir(), 'kdz-profile-'));
    for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      writeFileSync(join(dir, name), 'held-by-a-process-that-is-gone');
    }

    return dir;
  }

  it('removes the guards a killed Chrome left behind', () => {
    // The next Chrome to open the profile tries to hand off to the
    // instance these name, and waits. The visible symptom is that
    // POST /v1/sessions never answers while /v1/health keeps returning
    // 200, so the caller times out against something that reads healthy.
    const dir = profile();

    clearSingletonGuards(dir);

    expect(existsSync(join(dir, 'SingletonLock'))).toBe(false);
    expect(existsSync(join(dir, 'SingletonCookie'))).toBe(false);
    expect(existsSync(join(dir, 'SingletonSocket'))).toBe(false);
  });

  it('leaves everything that constitutes a login alone', () => {
    // The entire value of a persistent profile is that the account
    // stays signed in. Clearing a lock must never cost that.
    const dir = profile();
    writeFileSync(join(dir, 'Local State'), '{"os_crypt":{}}');
    mkdirSync(join(dir, 'Default'), { recursive: true });
    writeFileSync(join(dir, 'Default', 'Cookies'), 'sqlite-ish');

    clearSingletonGuards(dir);

    expect(readFileSync(join(dir, 'Local State'), 'utf8')).toContain('os_crypt');
    expect(readFileSync(join(dir, 'Default', 'Cookies'), 'utf8')).toBe('sqlite-ish');
  });

  it('is a no-op on a profile that was shut down cleanly', () => {
    // It runs on every launch, including the overwhelming majority
    // where there is nothing to clear.
    const dir = mkdtempSync(join(tmpdir(), 'kdz-profile-'));

    expect(() => clearSingletonGuards(dir)).not.toThrow();
  });
});
