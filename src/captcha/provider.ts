import type { Page } from 'patchright';

/**
 * Plugin contract for captcha providers. Implementations live under
 * `src/captcha/<provider>.ts` and are wired into the registry in
 * `src/captcha/index.ts`. The scenario step `solveCaptcha` resolves
 * the provider by name at runtime and delegates the actual solve.
 *
 * Each provider receives the live page plus the spec parsed off the
 * step config (siteKey, type, etc.). On success, it returns the token
 * string to be injected into the page; on failure, it throws so the
 * runner records a step error.
 */
export interface CaptchaProvider {
  readonly name: string;
  solve(page: Page, spec: CaptchaSpec): Promise<string>;
}

export interface CaptchaSpec {
  type: 'recaptchaV2' | 'hcaptcha' | 'turnstile';
  siteKey?: string;
  pageUrl?: string;
  timeout?: number;
}
