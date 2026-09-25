import { describe, expect, it } from 'vitest';
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
        maxAttempts: 3,
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

  it('reports a config file that fails to load', async () => {
    const root = await writeProject({ 'ccc.config.ts': 'export default {\n' });
    const { config, diagnostics } = await loadConfig(root);
    expect(config.maxAttempts).toBe(3);
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
