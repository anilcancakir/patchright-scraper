import { z } from 'zod';

/**
 * Wire types shared between the Fastify server and the Laravel client.
 * Mirrors `App\Support\Scraping\ScraperRequest` / `ScraperResponse` so
 * the engine contract stays consistent across language boundaries.
 */

export const ProxySchema = z.object({
  server: z.string(),
  username: z.string().optional(),
  password: z.string().optional(),
});

export const ScrapeRequestSchema = z.object({
  url: z.string().url(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
  headers: z.record(z.string()).default({}),
  body: z.string().optional(),
  cookies: z.record(z.string()).default({}),
  timeoutSeconds: z.number().int().positive().default(30),
  maxRedirects: z.number().int().nonnegative().default(5),
  proxy: ProxySchema.optional(),
  userAgent: z.string().optional(),
  locale: z.string().optional(),
  viewport: z
    .object({ width: z.number().int(), height: z.number().int() })
    .optional(),
  screenshot: z.boolean().default(false),
});

export const SessionCreateSchema = z.object({
  sessionId: z.string().optional(),
  proxy: ProxySchema.optional(),
  userAgent: z.string().optional(),
  locale: z.string().optional(),
  viewport: z
    .object({ width: z.number().int(), height: z.number().int() })
    .optional(),
  bearer: z.string().optional(),
  ignoreHTTPSErrors: z.boolean().optional(),
});

export type ScrapeRequest = z.infer<typeof ScrapeRequestSchema>;
export type SessionCreate = z.infer<typeof SessionCreateSchema>;

export interface ScrapeResponse {
  status: number;
  finalUrl: string;
  headers: Record<string, string>;
  body: string;
  cookies: Array<{ name: string; value: string; domain?: string; path?: string }>;
  timingMs: number;
  screenshot?: string;
}
