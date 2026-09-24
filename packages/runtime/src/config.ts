export interface CccConfig {
  models?: { impl?: string; tests?: string };
  maxAttempts?: number;
  testMaxAttempts?: number;
  concurrency?: number;
}

export function defineConfig(config: CccConfig): CccConfig {
  return config;
}
