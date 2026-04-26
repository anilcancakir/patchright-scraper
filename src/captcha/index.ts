import { DummyCaptchaProvider } from './dummy.js';
import type { CaptchaProvider } from './provider.js';

const providers = new Map<string, CaptchaProvider>();

export function registerCaptchaProvider(provider: CaptchaProvider): void {
  providers.set(provider.name, provider);
}

export function resolveCaptchaProvider(name: string): CaptchaProvider {
  const provider = providers.get(name);
  if (provider !== undefined) {
    return provider;
  }

  throw new Error(`Captcha provider "${name}" is not registered.`);
}

// Wire defaults at module load.
registerCaptchaProvider(new DummyCaptchaProvider());

export type { CaptchaProvider, CaptchaSpec } from './provider.js';
