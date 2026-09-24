import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL, loadConfig } from '../src/config.js';
import { writeProject } from './helpers.js';

describe('loadConfig', () => {
  it('returns defaults when there is no config file', async () => {
    const root = await writeProject({ 'concepts/.keep': '' });
    expect(await loadConfig(root)).toEqual({
      config: { models: { impl: DEFAULT_MODEL, tests: DEFAULT_MODEL }, maxAttempts: 3, testMaxAttempts: 3, concurrency: 4 },
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
      models: { impl: 'claude-sonnet-5', tests: DEFAULT_MODEL },
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

  it('reports a config file that fails to load', async () => {
    const root = await writeProject({ 'ccc.config.ts': 'export default {\n' });
    const { config, diagnostics } = await loadConfig(root);
    expect(config.maxAttempts).toBe(3);
    expect(diagnostics[0]?.message).toMatch(/^cannot load config: /);
  });
});
