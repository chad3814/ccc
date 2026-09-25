import { defineConfig } from '@ccc/runtime';

export default defineConfig({
  // Defaults: impl starts on claude-haiku-4-5, tests on claude-sonnet-5, both
  // escalate after 2 failed attempts and stop at claude-opus-5.
  maxAttempts: 8,
  testMaxAttempts: 5,
  concurrency: 4,
});
