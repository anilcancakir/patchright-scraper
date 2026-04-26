import type { FastifyInstance } from 'fastify';
import { oneShotScrape, runScrape } from './browser.js';
import {
  createSession,
  destroySession,
  getSession,
  listSessions,
} from './session.js';
import { ScrapeRequestSchema, SessionCreateSchema } from './types.js';

/**
 * Register every route the Laravel `PatchrightClient` consumes.
 *
 * Endpoint contract:
 *  POST   /v1/scrape                       one-shot scrape
 *  POST   /v1/sessions                      create or look up a session
 *  DELETE /v1/sessions/:id                  close a session, drop profile dir
 *  POST   /v1/sessions/:id/scrape           scrape inside a session
 *  GET    /v1/sessions                      list active sessions
 *  GET    /v1/health                        ping
 */
export function registerRoutes(app: FastifyInstance): void {
  app.get('/v1/health', async () => ({ status: 'ok' }));

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
    const parsed = SessionCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(422);

      return { status: 'error', message: 'invalid request', issues: parsed.error.issues };
    }

    try {
      const session = await createSession(parsed.data);

      return {
        status: 'ok',
        session: { id: session.id, profilePath: session.profilePath },
      };
    } catch (error) {
      reply.code(500);

      return { status: 'error', message: (error as Error).message };
    }
  });

  app.get('/v1/sessions', async () => ({
    status: 'ok',
    sessions: listSessions(),
  }));

  app.delete('/v1/sessions/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const closed = await destroySession(id);

    if (!closed) {
      reply.code(404);

      return { status: 'error', message: 'session not found' };
    }

    return { status: 'ok' };
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
}
