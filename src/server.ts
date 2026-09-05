import Fastify from 'fastify';
import { registerRoutes } from './routes.js';
import { closeAllSessions, hydrateBearerRegistry, startIdleReaper } from './session.js';

/**
 * How long shutdown may spend closing browsers.
 *
 * `containerStop` grants ten seconds before SIGKILL. Six leaves room
 * for Fastify to drain and for the process to actually exit, and a
 * context still open at six was going to be killed at ten anyway.
 */
const SHUTDOWN_BUDGET_MS = 6_000;

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

  // Shut the browsers down, do not just walk away from them.
  //
  // This used to close Fastify and exit, which left every live Chrome to
  // be killed with the container: nothing flushed, and the profile's own
  // singleton guards left for the next launch to clear.
  //
  // It does not fix the "Restore pages?" bubble, which is what it was
  // written for. Measured on prod 2026-09-06, `closed: 1` and no chrome
  // left, and the released profile still read exit_type "Crashed".
  // clearCrashMarker() in session.ts carries that on its own.
  let shuttingDown = false;

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      // A second signal during the drain must not start a second one:
      // both would race the same contexts and the loser would report a
      // close failure for work the winner did.
      if (shuttingDown) {
        return;
      }

      shuttingDown = true;
      clearInterval(reaper);

      closeAllSessions(SHUTDOWN_BUDGET_MS)
        .then((closed) => app.log.info({ signal, closed }, 'closed browser contexts before exit'))
        .catch((error) => app.log.warn({ signal, error }, 'browser shutdown did not complete'))
        .finally(() => app.close().finally(() => process.exit(0)));
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
