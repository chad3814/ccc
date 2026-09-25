import { defineConfig } from '@ccc/runtime';

export default defineConfig({
  maxAttempts: 3,
  testMaxAttempts: 3,
  concurrency: 4,
});
