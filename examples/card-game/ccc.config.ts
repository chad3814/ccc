import { defineConfig } from '@ccc/runtime';

export default defineConfig({
  //models: { impl: 'claude-haiku-4-5', tests: 'claude-haiku-4-5' },
  maxAttempts: 8,
  testMaxAttempts: 5,
  concurrency: 4,
});
