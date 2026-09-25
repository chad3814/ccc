// A model name fixes one model; a range starts at `start` and escalates
// along the ladder after repeated failures, never past `cap`.
export type ModelChoice = string | { start: string; cap: string };

export interface CccConfig {
  models?: { impl?: ModelChoice; tests?: ModelChoice };
  // Models from weakest to strongest.
  ladder?: string[];
  // Failed attempts on one model before moving up a step.
  escalateAfter?: number;
  maxAttempts?: number;
  testMaxAttempts?: number;
  concurrency?: number;
}

export function defineConfig(config: CccConfig): CccConfig {
  return config;
}
