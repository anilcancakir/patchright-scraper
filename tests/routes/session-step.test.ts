import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the session module so the routes layer talks to fakes instead of
// real Patchright contexts. Each test sets the behaviour it needs.
vi.mock('../../src/session.js', async () => {
  return await import('./_session-stub.js');
});

import { registerRoutes } from '../../src/routes.js';
import { __resetStub, __setStub } from './_session-stub.js';

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
  __resetStub();
});

describe('POST /v1/sessions', () => {
  it('returns 200 with the new session id', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: { sessionId: 'abc-123', loginSignature: 'instagram\\.com/accounts/login' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.session.id).toBe('abc-123');
    expect(body.session.state).toBe('active');
  });
});

describe('GET /v1/sessions/:id/state', () => {
  it('returns the current state + url', async () => {
    __setStub({ id: 'state-test', state: 'active', url: 'https://example.org/' });

    const response = await app.inject({ method: 'GET', url: '/v1/sessions/state-test/state' });

    expect(response.statusCode).toBe(200);
    expect(response.json().session.state).toBe('active');
    expect(response.json().session.url).toBe('https://example.org/');
  });

  it('returns 404 for unknown session', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/sessions/missing/state' });

    expect(response.statusCode).toBe(404);
  });
});

describe('POST /v1/sessions/:id/step', () => {
  it('dispatches goto and returns the result', async () => {
    __setStub({
      id: 'step-test',
      state: 'active',
      url: 'https://example.org/landing',
      gotoSpy: vi.fn(async () => ({ status: () => 200 })),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/sessions/step-test/step',
      payload: { type: 'goto', config: { url: 'https://example.org/landing', waitUntil: 'load' } },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('ok');
    expect(body.step).toBe('goto');
    expect(body.result.ok).toBe(true);
    expect(body.result.state).toBe('active');
  });

  it('returns 404 for unknown step type', async () => {
    __setStub({ id: 'step-test', state: 'active' });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/sessions/step-test/step',
      payload: { type: 'frobnicate', config: {} },
    });

    expect(response.statusCode).toBe(404);
  });

  it('returns 422 for invalid config', async () => {
    __setStub({ id: 'step-test', state: 'active' });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/sessions/step-test/step',
      payload: { type: 'goto', config: { url: 'not a url' } },
    });

    expect(response.statusCode).toBe(422);
  });
});
