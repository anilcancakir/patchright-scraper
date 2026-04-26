import { zodToJsonSchema } from 'zod-to-json-schema';
import type { StepExecutor } from './types.js';

/**
 * Operator-facing descriptor that `GET /v1/steps` returns per executor.
 * The PHP AutomationClient introspects this shape to validate scenario
 * step configs against the live Node contract.
 */
export interface StepDescriptor {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

/**
 * Runtime registry of step executors. Step files register themselves at
 * boot via `src/steps/index.ts`; the routes layer dispatches by `name`.
 */
class StepRegistry {
  private readonly entries = new Map<string, StepExecutor>();

  register(executor: StepExecutor): void {
    if (this.entries.has(executor.name)) {
      throw new Error(`Step "${executor.name}" already registered.`);
    }

    this.entries.set(executor.name, executor);
  }

  get(name: string): StepExecutor | undefined {
    return this.entries.get(name);
  }

  list(): string[] {
    return [...this.entries.keys()].sort();
  }

  /**
   * Sorted descriptors for every registered executor. Each descriptor
   * carries the JSON Schema serialization of the zod schema so HTTP
   * consumers can inspect parameter shape without reaching into zod.
   */
  describe(): StepDescriptor[] {
    return this.list().map((name) => {
      const executor = this.entries.get(name);
      if (executor === undefined) {
        throw new Error(`Step "${name}" registered name has no entry.`);
      }

      return {
        name: executor.name,
        description: executor.description ?? '',
        schema: zodToJsonSchema(executor.schema, { target: 'jsonSchema7' }) as Record<string, unknown>,
      };
    });
  }

  /**
   * Reset the registry. Test-only convenience; production code should
   * never call this.
   */
  reset(): void {
    this.entries.clear();
  }
}

export const stepRegistry = new StepRegistry();
