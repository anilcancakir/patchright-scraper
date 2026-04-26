import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registerRoutes } from '../../src/routes.js';
import '../../src/steps/index.js';
import { stepRegistry } from '../../src/steps/registry.js';

/**
 * Pins the `GET /v1/steps` payload shape: every entry carries the
 * Playwright-shaped JSON Schema for its zod schema plus an operator
 * description. The PHP AutomationClient introspects this contract.
 */
let app: Awaited<ReturnType<typeof buildApp>>;

async function buildApp() {
  const instance = Fastify({ logger: false });
  registerRoutes(instance);
  await instance.ready();
  return instance;
}

beforeEach(async () => {
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
});

describe('GET /v1/steps', () => {
  it('returns descriptors for every registered executor', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/steps' });

    expect(response.statusCode).toBe(200);

    const body = response.json() as { status: string; steps: Array<Record<string, unknown>> };
    expect(body.status).toBe('ok');
    expect(body.steps.length).toBe(stepRegistry.list().length);

    const goto = body.steps.find((step) => step.name === 'goto') as
      | { name: string; description: string; schema: { properties: Record<string, unknown> } }
      | undefined;

    expect(goto).toBeDefined();
    expect(goto?.description).toContain('Navigate');
    expect(goto?.schema.properties.url).toBeDefined();
    expect(goto?.schema.properties.waitUntil).toBeDefined();
  });
});
