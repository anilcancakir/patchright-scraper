import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { oneShotScrape, runScrape } from './browser.js';
import {
  createSession,
  destroySession,
  getSession,
  listSessions,
  refreshState,
} from './session.js';
import type { ManagedSession } from './session.js';
import { stepRegistry } from './steps/index.js';
import type { StepContext } from './steps/types.js';
import { ScrapeRequestSchema, SessionCreateSchema } from './types.js';

const SessionCreateExtendedSchema = SessionCreateSchema.extend({
  loginSignature: z.string().optional(),
  identityHash: z.string().optional(),
});

const StepRequestSchema = z.object({
  type: z.string(),
  config: z.record(z.unknown()).default({}),
});

/**
 * Build the StepContext object that step executors receive.
 */
function buildStepContext(session: ManagedSession, log: (msg: string, meta?: Record<string, unknown>) => void): StepContext {
  return {
    context: session.context,
    page: session.page,
    sessionId: session.id,
    log,
  };
}

/**
 * Register every route the Laravel client consumes.
 *
 * Endpoint contract:
 *  GET    /v1/health                        liveness probe
 *  POST   /v1/scrape                        one-shot scrape
 *  POST   /v1/sessions                      create or look up a session
 *  GET    /v1/sessions                      list active sessions
 *  DELETE /v1/sessions/:id                  close a session
 *  POST   /v1/sessions/:id/scrape           scrape inside a session
 *  POST   /v1/sessions/:id/navigate         navigate the session's page
 *  POST   /v1/sessions/:id/step             execute a registered step
 *  POST   /v1/sessions/:id/screenshot       capture a screenshot
 *  GET    /v1/sessions/:id/state            current session state
 *  GET    /v1/steps                         list registered step descriptors (name, description, JSON schema)
 */
export function registerRoutes(app: FastifyInstance): void {
  app.get('/v1/health', async () => ({ status: 'ok' }));

  app.get('/v1/steps', async () => ({ status: 'ok', steps: stepRegistry.describe() }));

  app.post('/v1/scrape', async (request, reply) => {
    const parsed = ScrapeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(422);
      return { status: 'error', message: 'invalid request', issues: parsed.error.issues };
    }

    try {
      const result = await oneShotScrape(parsed.data);
      return { status: 'ok', solution: result };
    } catch (error) {
      reply.code(500);
      return { status: 'error', message: (error as Error).message };
    }
  });

  app.post('/v1/sessions', async (request, reply) => {
    const parsed = SessionCreateExtendedSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(422);
      return { status: 'error', message: 'invalid request', issues: parsed.error.issues };
    }

    try {
      const session = await createSession(parsed.data);
      return {
        status: 'ok',
        session: {
          id: session.id,
          state: session.state,
          profilePath: session.profilePath,
        },
      };
    } catch (error) {
      reply.code(500);
      return { status: 'error', message: (error as Error).message };
    }
  });

  app.get('/v1/sessions', async () => ({ status: 'ok', sessions: listSessions() }));

  app.delete('/v1/sessions/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const closed = await destroySession(id);
    if (!closed) {
      reply.code(404);
      return { status: 'error', message: 'session not found' };
    }
    return { status: 'ok' };
  });

  app.get('/v1/sessions/:id/state', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = getSession(id);
    if (session === undefined) {
      reply.code(404);
      return { status: 'error', message: 'session not found' };
    }
    refreshState(session);
    return {
      status: 'ok',
      session: {
        id: session.id,
        state: session.state,
        url: session.page.url(),
        last_used_at: session.lastUsedAt,
      },
    };
  });

  app.post('/v1/sessions/:id/scrape', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = getSession(id);
    if (session === undefined) {
      reply.code(404);
      return { status: 'error', message: 'session not found' };
    }

    const parsed = ScrapeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(422);
      return { status: 'error', message: 'invalid request', issues: parsed.error.issues };
    }

    try {
      const result = await runScrape(session.context, parsed.data);
      return { status: 'ok', solution: result };
    } catch (error) {
      reply.code(500);
      return { status: 'error', message: (error as Error).message };
    }
  });

  app.post('/v1/sessions/:id/navigate', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = getSession(id);
    if (session === undefined) {
      reply.code(404);
      return { status: 'error', message: 'session not found' };
    }

    return runStep(app, session, 'goto', request.body, reply);
  });

  app.post('/v1/sessions/:id/screenshot', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = getSession(id);
    if (session === undefined) {
      reply.code(404);
      return { status: 'error', message: 'session not found' };
    }

    return runStep(app, session, 'screenshot', request.body ?? {}, reply);
  });

  app.post('/v1/sessions/:id/step', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = getSession(id);
    if (session === undefined) {
      reply.code(404);
      return { status: 'error', message: 'session not found' };
    }

    const parsed = StepRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(422);
      return { status: 'error', message: 'invalid request', issues: parsed.error.issues };
    }

    return runStep(app, session, parsed.data.type, parsed.data.config, reply);
  });
}

/**
 * Dispatch a step by name. Validates config against the executor's
 * schema, runs it, refreshes session state, and shapes the response.
 */
async function runStep(
  app: FastifyInstance,
  session: ManagedSession,
  type: string,
  rawConfig: unknown,
  reply: FastifyReply,
): Promise<unknown> {
  const executor = stepRegistry.get(type);
  if (executor === undefined) {
    reply.code(404);
    return { status: 'error', message: `unknown step type: ${type}` };
  }

  const configParse = executor.schema.safeParse(rawConfig);
  if (!configParse.success) {
    reply.code(422);
    return { status: 'error', message: 'invalid step config', issues: configParse.error.issues };
  }

  const ctx = buildStepContext(session, (msg, meta) => app.log.info(meta ?? {}, msg));
  const startedAt = Date.now();

  try {
    const result = await executor.execute(ctx, configParse.data);
    const state = refreshState(session);

    return {
      status: result.ok ? 'ok' : 'error',
      step: type,
      result: {
        ...result,
        durationMs: Date.now() - startedAt,
        state,
      },
    };
  } catch (error) {
    refreshState(session);
    reply.code(500);
    return {
      status: 'error',
      step: type,
      message: (error as Error).message,
    };
  }
}
