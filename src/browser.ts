import { chromium, type Browser, type BrowserContext } from 'patchright';
import type { ScrapeRequest, ScrapeResponse } from './types.js';

/**
 * One-shot scrape: launch a fresh persistent context per call so the
 * cookie jar does not leak between unrelated requests. Session-based
 * scraping reuses an existing context (see session.ts).
 */
export async function oneShotScrape(req: ScrapeRequest): Promise<ScrapeResponse> {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chrome',
    headless: true,
    proxy: req.proxy,
    userAgent: req.userAgent,
    locale: req.locale,
    viewport: req.viewport ?? null,
  });

  try {
    return await runScrape(context, req);
  } finally {
    await context.close();
  }
}

/**
 * Drive a request through an existing context (session reuse path).
 */
export async function runScrape(
  context: BrowserContext,
  req: ScrapeRequest,
): Promise<ScrapeResponse> {
  const page = await context.newPage();

  if (Object.keys(req.cookies).length > 0) {
    const url = new URL(req.url);
    await context.addCookies(
      Object.entries(req.cookies).map(([name, value]) => ({
        name,
        value,
        domain: url.hostname,
        path: '/',
      })),
    );
  }

  const start = Date.now();

  try {
    const response = await page.goto(req.url, {
      timeout: req.timeoutSeconds * 1000,
      waitUntil: 'domcontentloaded',
    });

    if (response === null) {
      throw new Error('navigation returned null response');
    }

    const finalUrl = page.url();
    const status = response.status();
    const headers = response.headers();
    const body = await page.content();

    const cookies = (await context.cookies()).map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
    }));

    let screenshot: string | undefined;
    if (req.screenshot) {
      const buffer = await page.screenshot({ fullPage: true, type: 'png' });
      screenshot = buffer.toString('base64');
    }

    return {
      status,
      finalUrl,
      headers,
      body,
      cookies,
      timingMs: Date.now() - start,
      screenshot,
    };
  } finally {
    await page.close();
  }
}

/**
 * Singleton browser handle for ad-hoc one-shot work that bypasses the
 * persistent context overhead. Currently unused; retained as a future
 * optimisation hook.
 */
let cachedBrowser: Browser | null = null;
export async function ensureBrowser(): Promise<Browser> {
  if (cachedBrowser !== null) {
    return cachedBrowser;
  }

  cachedBrowser = await chromium.launch({ channel: 'chrome', headless: true });

  return cachedBrowser;
}
