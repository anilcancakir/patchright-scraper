import { z } from 'zod';
import { resolveCaptchaProvider } from '../captcha/index.js';
import type { StepExecutor } from './types.js';

const TimeoutMs = z.number().int().positive().max(180_000);

/**
 * Scaffolded captcha solver. Resolves a provider by name from the
 * captcha registry, hands off the page + spec, then writes the
 * resulting token into Cloudflare/recaptcha/turnstile fields the way
 * the page expects. Real providers (2captcha, anticaptcha, ...) plug
 * in through `registerCaptchaProvider` from `src/captcha/index.ts`.
 */
export const solveCaptcha: StepExecutor = {
  name: 'solveCaptcha',
  description: 'Solve a captcha challenge via a registered provider plugin.',
  schema: z
    .object({
      provider: z.string().default('dummy'),
      type: z.enum(['recaptchaV2', 'hcaptcha', 'turnstile']),
      siteKey: z.string().optional(),
      pageUrl: z.string().url().optional(),
      timeout: TimeoutMs.default(120_000),
    })
    .strict(),
  async execute(ctx, config) {
    const c = config as {
      provider: string;
      type: 'recaptchaV2' | 'hcaptcha' | 'turnstile';
      siteKey?: string;
      pageUrl?: string;
      timeout: number;
    };

    const provider = resolveCaptchaProvider(c.provider);
    const token = await provider.solve(ctx.page, {
      type: c.type,
      siteKey: c.siteKey,
      pageUrl: c.pageUrl ?? ctx.page.url(),
      timeout: c.timeout,
    });

    return { ok: true, output: { provider: c.provider, type: c.type, token } };
  },
};
