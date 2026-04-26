import type { BrowserContext, Page } from 'patchright';
import type { ZodSchema } from 'zod';

/**
 * Context every step executor receives. The Fastify routes layer builds
 * this object for each `POST /v1/sessions/:id/step` call so executors
 * never reach into module-level state.
 */
export interface StepContext {
  /** The session's persistent context. */
  context: BrowserContext;
  /** The active page. Single-page sessions only in v0.2.0. */
  page: Page;
  /** Stable session id (used for capture push correlation). */
  sessionId: string;
  /** Structured logger. Same shape as Fastify's logger. */
  log: (msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * Wire-shape every executor returns. `ok=true` lets the caller treat
 * `output` as the step-specific payload; `ok=false` carries `error`.
 */
export interface StepResult {
  ok: boolean;
  output?: unknown;
  error?: string;
  screenshot?: string;
  state?: SessionState;
  durationMs?: number;
}

export type SessionState = 'booting' | 'active' | 'idle' | 'login_detected' | 'errored' | 'closed';

/**
 * A registered scenario step primitive. Implementations live in
 * `src/steps/<category>.ts` and register themselves through
 * `src/steps/index.ts`.
 */
export interface StepExecutor<TConfig = unknown> {
  /** Unique snake_case identifier dispatched on `POST /sessions/:id/step`. */
  readonly name: string;
  /** Zod schema validates the incoming config before `execute` runs. */
  readonly schema: ZodSchema<TConfig>;
  execute(ctx: StepContext, config: TConfig): Promise<StepResult>;
}
