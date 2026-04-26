import { describe, expect, it } from 'vitest';
import { resolveLaunchArgs } from '../../src/browser/launch-args.js';

describe('resolveLaunchArgs', () => {
  it('returns sensible defaults when env is empty', () => {
    const result = resolveLaunchArgs({});
    expect(result.headless).toBe(true);
    expect(result.locale).toBe('en-US');
    expect(result.viewport).toEqual({ width: 1920, height: 1080 });
    expect(result.extraArgs).toEqual([]);
    expect(result.proxy).toBeUndefined();
  });

  it('honours HEADLESS=0 to force headed', () => {
    expect(resolveLaunchArgs({ HEADLESS: '0' }).headless).toBe(false);
    expect(resolveLaunchArgs({ HEADLESS: '1' }).headless).toBe(true);
  });

  it('headless=auto + DISPLAY set means headed', () => {
    expect(resolveLaunchArgs({ DISPLAY: ':99' }).headless).toBe(false);
    expect(resolveLaunchArgs({}).headless).toBe(true);
  });

  it('parses VIEWPORT in WxH format', () => {
    expect(resolveLaunchArgs({ VIEWPORT: '1280x720' }).viewport).toEqual({ width: 1280, height: 720 });
  });

  it('falls back to default for invalid VIEWPORT', () => {
    expect(resolveLaunchArgs({ VIEWPORT: 'huh' }).viewport).toEqual({ width: 1920, height: 1080 });
  });

  it('parses EXTRA_LAUNCH_ARGS_JSON as a string array', () => {
    expect(resolveLaunchArgs({ EXTRA_LAUNCH_ARGS_JSON: '["--no-sandbox","--lang=tr"]' }).extraArgs).toEqual([
      '--no-sandbox',
      '--lang=tr',
    ]);
  });

  it('drops malformed EXTRA_LAUNCH_ARGS_JSON silently', () => {
    expect(resolveLaunchArgs({ EXTRA_LAUNCH_ARGS_JSON: 'not json' }).extraArgs).toEqual([]);
  });

  it('parses PROXY in host:port form', () => {
    expect(resolveLaunchArgs({ PROXY: '10.0.0.1:8080' }).proxy).toEqual({ server: 'http://10.0.0.1:8080' });
  });

  it('parses PROXY with auth', () => {
    expect(resolveLaunchArgs({ PROXY: '10.0.0.1:8080:user:pass' }).proxy).toEqual({
      server: 'http://10.0.0.1:8080',
      username: 'user',
      password: 'pass',
    });
  });

  it('returns undefined for malformed PROXY', () => {
    expect(resolveLaunchArgs({ PROXY: 'host-only' }).proxy).toBeUndefined();
    expect(resolveLaunchArgs({ PROXY: 'a:b:c' }).proxy).toBeUndefined();
  });
});
