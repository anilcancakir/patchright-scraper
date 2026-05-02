import Fastify from 'fastify';
import { registerRoutes } from './routes.js';
import { hydrateBearerRegistry, startIdleReaper } from './session.js';

/**
 * Boot the Patchright Fastify HTTP service.
 *
 * Listens on PORT (default 8190) and registers the /v1 routes the
 * Laravel `PatchrightClient` calls.
 */
async function main(): Promise<void> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
  });

  hydrateBearerRegistry();
  registerRoutes(app);

  const reaper = startIdleReaper();

  const port = Number(process.env.PORT ?? 8190);
  const host = process.env.HOST ?? '0.0.0.0';

  await app.listen({ port, host });

  app.log.info({ port, host }, 'patchright-scraper listening');

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      clearInterval(reaper);
      app.close().finally(() => process.exit(0));
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
