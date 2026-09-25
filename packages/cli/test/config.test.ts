import { describe, expect, it } from 'vitest';
import type { CccConfig } from '@ccc/runtime';
import type { z } from 'zod';
import { DEFAULT_LADDER, configSchema, loadConfig, modelTiers } from '../src/config.js';
import { writeProject } from './helpers.js';

describe('loadConfig', () => {
  it('returns defaults when there is no config file', async () => {
    const root = await writeProject({ 'concepts/.keep': '' });
    expect(await loadConfig(root)).toEqual({
      config: {
        models: {
          impl: { start: 'claude-haiku-4-5', cap: 'claude-opus-5' },
          tests: { start: 'claude-sonnet-5', cap: 'claude-opus-5' },
        },
        ladder: DEFAULT_LADDER,
        escalateAfter: 2,
        maxAttempts: 6,
        testMaxAttempts: 3,
        concurrency: 4,
      },
      diagnostics: [],
    });
  });

  it('merges a partial config with the defaults', async () => {
    const root = await writeProject({
      'ccc.config.ts': "export default { maxAttempts: 5, models: { impl: 'claude-sonnet-5' } };\n",
    });
    const { config, diagnostics } = await loadConfig(root);
    expect(diagnostics).toEqual([]);
    expect(config).toEqual({
      models: { impl: 'claude-sonnet-5', tests: { start: 'claude-sonnet-5', cap: 'claude-opus-5' } },
      ladder: DEFAULT_LADDER,
      escalateAfter: 2,
      maxAttempts: 5,
      testMaxAttempts: 3,
      concurrency: 4,
    });
  });

  it('reports invalid values and unknown keys', async () => {
    const root = await writeProject({ 'ccc.config.ts': 'export default { maxAttempts: 0, retries: 2 };\n' });
    const { diagnostics } = await loadConfig(root);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.map((d) => d.message)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^maxAttempts: /), expect.stringMatching(/^config: .*retries/)]),
    );
    expect(diagnostics.every((d) => d.file === 'ccc.config.ts')).toBe(true);
  });

  it('rejects a start or cap that is not on the ladder, or a start above its cap', async () => {
    const root = await writeProject({
      'ccc.config.ts': [
        'export default { models: {',
        "  impl: { start: 'claude-haiku-9', cap: 'claude-opus-5' },",
        "  tests: { start: 'claude-opus-5', cap: 'claude-sonnet-5' },",
        '} };\n',
      ].join('\n'),
    });
    const { diagnostics } = await loadConfig(root);
    expect(diagnostics.map((d) => d.message)).toEqual([
      "models.impl.start: 'claude-haiku-9' is not on the ladder",
      "models.tests: start 'claude-opus-5' is above cap 'claude-sonnet-5' on the ladder",
    ]);
  });

  it('warns when the attempts can never reach the cap', async () => {
    const root = await writeProject({ 'ccc.config.ts': 'export default { maxAttempts: 3 };\n' });
    const { diagnostics } = await loadConfig(root);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        severity: 'warning',
        file: 'ccc.config.ts',
        message: "maxAttempts: 3 attempts escalating after every 2 never reach cap 'claude-opus-5' for impl (needs 5)",
      }),
    ]);
  });

  it('reaches the cap with the default attempts', async () => {
    const root = await writeProject({ 'concepts/.keep': '' });
    const { config } = await loadConfig(root);
    for (const artifact of ['impl', 'tests'] as const) {
      const attempts = artifact === 'impl' ? config.maxAttempts : config.testMaxAttempts;
      expect(config.escalateAfter * (modelTiers(config, artifact).length - 1) + 1).toBeLessThanOrEqual(attempts);
    }
  });

  it('reports a config file that fails to load', async () => {
    const root = await writeProject({ 'ccc.config.ts': 'export default {\n' });
    const { config, diagnostics } = await loadConfig(root);
    expect(config.maxAttempts).toBe(6);
    expect(diagnostics[0]?.message).toMatch(/^cannot load config: /);
  });

  describe('modelTiers', () => {
    it('lists the ladder from start through cap', () => {
      const config = configSchema.parse({});
      expect(modelTiers(config, 'impl')).toEqual(['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5']);
      expect(modelTiers(config, 'tests')).toEqual(['claude-sonnet-5', 'claude-opus-5']);
    });

    it('treats a plain model as a single fixed tier, on the ladder or not', () => {
      const config = configSchema.parse({ models: { impl: 'my-model', tests: 'claude-opus-5' } });
      expect(modelTiers(config, 'impl')).toEqual(['my-model']);
      expect(modelTiers(config, 'tests')).toEqual(['claude-opus-5']);
    });

    it('follows a custom ladder', () => {
      const config = configSchema.parse({
        ladder: ['a', 'b', 'c'],
        models: { impl: { start: 'b', cap: 'c' }, tests: { start: 'a', cap: 'a' } },
      });
      expect(modelTiers(config, 'impl')).toEqual(['b', 'c']);
      expect(modelTiers(config, 'tests')).toEqual(['a']);
    });
  });
});

// defineConfig's parameter type must accept exactly what the schema accepts.
describe('CccConfig', () => {
  it('matches the config schema input both ways', () => {
    const fromRuntime = (config: CccConfig): z.input<typeof configSchema> => config;
    const toRuntime = (config: z.input<typeof configSchema>): CccConfig => config;
    const sample: CccConfig = { models: { impl: { start: 'claude-haiku-4-5', cap: 'claude-opus-5' }, tests: 'claude-opus-5' }, escalateAfter: 2 };
    expect(configSchema.safeParse(toRuntime(fromRuntime(sample))).success).toBe(true);
  });
});
