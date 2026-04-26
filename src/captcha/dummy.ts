import type { CaptchaProvider, CaptchaSpec } from './provider.js';

/**
 * No-op provider that always rejects. Ships as the default so missing
 * `CAPTCHA_PROVIDER` configuration surfaces as a clear scenario failure
 * rather than a silent skip.
 */
export class DummyCaptchaProvider implements CaptchaProvider {
  readonly name = 'dummy';

  async solve(_page: unknown, spec: CaptchaSpec): Promise<string> {
    throw new Error(`Dummy captcha provider cannot solve ${spec.type}; configure a real provider.`);
  }
}
