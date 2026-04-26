import type { StepExecutor } from './types.js';

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
   * Reset the registry. Test-only convenience; production code should
   * never call this.
   */
  reset(): void {
    this.entries.clear();
  }
}

export const stepRegistry = new StepRegistry();
