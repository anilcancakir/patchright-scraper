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
  /**
   * IANA zone the browser should declare, e.g. `Europe/Istanbul`.
   *
   * Optional on purpose: when the caller names none, the container's
   * own `TIMEZONE` env decides, and the schema is non-strict, so a
   * caller that sends this key to an image predating it is ignored
   * rather than rejected.
   */
  timezoneId: z.string().optional(),
  viewport: z
    .object({ width: z.number().int(), height: z.number().int() })
    .optional(),
  bearer: z.string().optional(),
  ignoreHTTPSErrors: z.boolean().optional(),
  /**
   * Whether this session's traffic is being captured.
   *
   * Gates the `x-kodizm-session` request header, which exists only so
   * the mitm addon can attribute a flow back to a session. With capture
   * off nothing consumes it and every request to the target carries a
   * stable, non-standard header naming us, which is a free cross-request
   * correlator handed to whoever is on the other end.
   *
   * Defaults to false: a session that does not say it is being captured
   * is not, and the quiet default is the safe one.
   */
  captureTraffic: z.boolean().default(false),
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
